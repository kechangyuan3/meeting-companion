import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';
import WebSocket, {WebSocketServer} from 'ws';
import {startMeeting} from '../server.mjs';

test('local access control, audio transport, task receipt and disconnect cancellation', async () => {
  const upstreamHTTP = createServer(); const upstreamWSS = new WebSocketServer({server: upstreamHTTP});
  await new Promise(resolve => upstreamHTTP.listen(0, '127.0.0.1', resolve));
  let upstream, sawAuthorization, gotAudio = false, stopped = false, executed = 0;
  const longStarted = Promise.withResolvers(); const longStopped = Promise.withResolvers();
  upstreamWSS.on('connection', (ws, req) => {
    upstream = ws; sawAuthorization = req.headers.authorization;
    ws.on('message', (bytes, binary) => {
      if (binary) {gotAudio = true; return;}
      const message = JSON.parse(bytes.toString());
      if (message.action === 'attach_session') ws.send(JSON.stringify({action: 'session_attached', data: {session_id: 'test-session', delegation: 'client'}}));
      if (message.action === 'session.thinking.append' || message.action === 'session.commentary.append') ws.send(JSON.stringify({action: message.action.replace('.append', '.appended'), data: {client_event_id: message.event_id, delegation_id: message.delegation_id}}));
    });
  });
  const app = await startMeeting({port: 0, upstreamUrl: `ws://127.0.0.1:${upstreamHTTP.address().port}`, verifyKey: async key => assert.equal(key, 'test-secret-key-123456'), run: async (task, {signal, reportProgress}) => {
    executed++; reportProgress('已收到任务');
    if (task.objective === 'long') {longStarted.resolve(); await new Promise(resolve => signal.addEventListener('abort', () => {stopped = true; longStopped.resolve(); resolve();}, {once: true})); throw Error('cancelled');}
    return '已核对的查询结果';
  }});
  let browser;
  try {
    assert.equal((await fetch(app.url + '/api/status')).status, 403);
    const root = await fetch(app.url); const cookie = root.headers.get('set-cookie').split(';')[0]; assert.match(await root.text(), /会议搭子/);
    const api = (path, data, origin = app.url) => fetch(app.url + path, {method: data ? 'POST' : 'GET', headers: {Cookie: cookie, Origin: origin, 'Content-Type': 'application/json'}, ...(data ? {body: JSON.stringify(data)} : {})});
    assert.equal((await api('/api/configure', {apiKey: 'test-secret-key-123456'}, 'https://untrusted.invalid')).status, 403);
    assert.equal((await api('/api/configure', {apiKey: 'test-secret-key-123456'})).status, 200);
    assert.equal((await api('/api/status')).status, 200);
    browser = new WebSocket(app.url.replace('http:', 'ws:') + '/connect', {headers: {Cookie: cookie, Origin: app.url}});
    await once(browser, 'open');
    const waitEvent = predicate => new Promise((resolve, reject) => {const timeout = setTimeout(() => reject(Error('event timeout')), 6000); const listener = bytes => {let message; try {message = JSON.parse(bytes.toString());} catch {return;} if (predicate(message)) {clearTimeout(timeout); browser.off('message', listener); resolve(message);}}; browser.on('message', listener);});
    await waitEvent(m => m.action === 'session_attached');
    assert.equal(sawAuthorization, 'Bearer test-secret-key-123456');
    browser.send(Buffer.alloc(640));
    const completed = waitEvent(m => m.type === 'local.task' && m.status === 'completed');
    const delegated = {action: 'session.delegation.created', data: {delegation: {id: 'query-1', target: 'client'}, purpose: 'task', objective: 'short', context: []}};
    upstream.send(JSON.stringify(delegated)); await completed;
    upstream.send(JSON.stringify(delegated)); await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(executed, 1, 'duplicate delegation must not execute twice'); assert.equal(gotAudio, true); assert.equal(app.metrics.tasksCompleted, 1);
    upstream.send(JSON.stringify({...delegated, data: {...delegated.data, delegation: {id: 'query-2', target: 'client'}, objective: 'long'}}));
    await longStarted.promise; browser.close(); await longStopped.promise; assert.equal(stopped, true);
    const state = JSON.stringify(await (await api('/api/status')).json()); assert.equal(state.includes('test-secret'), false);
  } finally {browser?.terminate(); await app.close(); upstream?.terminate(); await new Promise(resolve => upstreamWSS.close(resolve)); await new Promise(resolve => upstreamHTTP.close(resolve));}
});
