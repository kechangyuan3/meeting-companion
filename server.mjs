import {createServer} from 'node:http';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {randomBytes} from 'node:crypto';
import WebSocket, {WebSocketServer} from 'ws';
import {createDelegationBridge} from './vendor/mosslive/sdk/index.mjs';
import {validateRequest, filterEvent} from './runtime/public-api.mjs';
import {createCodexRunner} from './codex-runner.mjs';
import {createVexaClient} from './vexa-client.mjs';
import {recapRoute, RecapError} from './runtime/moss-recap.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const assets = new Set(['index.html', 'app.js', 'style.css', 'vexa.html', 'vexa.js', 'vexa.css', 'media/mic.js', 'media/pcm.js', 'media/capture-worklet.js', 'media/speaker.js', 'media/playback.js', 'media/public-session.js', 'media/recorder.js', 'recap.js']);
const allowedActions = new Set(['media.mode', 'mic_state', 'playback.chunk.completed', 'playback.completed', 'playback.stopped', 'session.update', 'conversation.item.create', 'response.create', 'ping']);
const json = (res, status, value) => {res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}); res.end(JSON.stringify(value));};
async function body(req) {
  let bytes = ''; for await (const chunk of req) {bytes += chunk; if (bytes.length > 65536) throw Error('请求过大');}
  return JSON.parse(bytes || '{}');
}
async function rawBody(req, limit) {
  if (Number(req.headers['content-length']) > limit) throw new RecapError('录音文件过大。', 413);
  const chunks = []; let size = 0;
  for await (const chunk of req) {size += chunk.length; if (size > limit) throw new RecapError('录音文件过大。', 413); chunks.push(chunk);}
  return new Uint8Array(Buffer.concat(chunks));
}
async function sendResponse(res, response) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  try {if (response.body) for await (const chunk of response.body) {if (res.destroyed) break; res.write(chunk);}}
  catch {res.destroy(); return;}
  res.end();
}
const recapPaths = new Set(['/api/moss/transcribe', '/api/moss/task', '/api/moss/summary', '/api/moss/ask', '/api/moss/voices', '/api/moss/speech']);

export async function startMeeting({port = 17860, apiKey = process.env.MOSS_API_KEY || '', codexPath, proxyUrl, run: suppliedRun,
  upstreamUrl = 'wss://api.mosi.cn/v1/realtime?model=moss-live-1.0', verifyKey, vexaBaseUrl, vexaFetch, mossFetch = fetch} = {}) {
  const cookie = randomBytes(32).toString('hex');
  let authority, active, verified = false, lastError = '', closed = false, backendTest = null;
  const metrics = {connections: 0, audioIn: 0, audioOut: 0, inputTurns: 0, outputTurns: 0, playbackReceipts: 0, tasksCompleted: 0, taskCount: 0, lastEvent: ''};
  const run = suppliedRun || (codexPath ? createCodexRunner({codexPath, proxyUrl, workspaceRoot: join(ROOT, '.state', 'workspaces')}) : async () => {throw Error('未找到 Codex，请安装并登录 Codex CLI，或设置 CODEX_PATH。');});
  const vexa = createVexaClient({run, baseUrl: vexaBaseUrl, fetchImpl: vexaFetch});
  const wss = new WebSocketServer({noServer: true, maxPayload: 4 * 1024 * 1024});
  const authorized = req => req.headers.cookie?.split(';').some(value => value.trim() === `moss_meeting=${cookie}`);
  const server = createServer(async (req, res) => {
    if (req.headers.host !== authority) return json(res, 403, {error: '请使用本机地址打开。'});
    const path = new URL(req.url, `http://${authority}`).pathname;
    if (path.startsWith('/api/')) {
      if (!authorized(req)) return json(res, 403, {error: '请先打开本机首页。'});
      if (req.method !== 'GET' && req.headers.origin !== `http://${authority}`) return json(res, 403, {error: '请求来源不正确。'});
      try {
        if (recapPaths.has(path) && req.method === 'POST') return await sendResponse(res, await recapRoute(path, {
          key: apiKey, fetchImpl: mossFetch, contentType: req.headers['content-type'], transcribeModel: req.headers['x-transcribe-model'], keyterms: req.headers['x-keyterms'],
          readBytes: limit => rawBody(req, limit),
          readJson: async limit => {try {return JSON.parse(Buffer.from(await rawBody(req, limit)).toString('utf8') || '{}');} catch (error) {throw error instanceof RecapError ? error : new RecapError('请求格式不正确。');}},
        }));
        if (path.startsWith('/api/vexa/')) return json(res, 200, await vexa.handle(path, req.method, req.method === 'POST' ? await body(req) : {}));
        if (path === '/api/status' && req.method === 'GET') return json(res, 200, {
          configured: !!apiKey, verified, backend: 'Codex', backendAvailable: !!(codexPath || suppliedRun), connected: !!active?.attached,
          metrics, lastError, backendTest: backendTest ? {state: backendTest.state, error: backendTest.error || ''} : null,
        });
        if (path === '/api/configure' && req.method === 'POST') {
          if (active) return json(res, 409, {error: '请先结束当前会议。'});
          const data = await body(req); const value = String(data.apiKey || '').trim();
          if (value.length < 12 || value.length > 4096 || /[\r\n]/.test(value)) return json(res, 400, {error: '请粘贴完整的 MOSS API Key。'});
          if (verifyKey) await verifyKey(value);
          else {
            const response = await fetch('https://api.mosi.cn/v1/models', {headers: {Authorization: `Bearer ${value}`}, signal: AbortSignal.timeout(20000)});
            if (!response.ok) throw Error(response.status === 401 || response.status === 403 ? '密钥无效或没有访问权限，请核对 MOSS 控制台。' : `MOSS 验证失败（HTTP ${response.status}），请稍后重试。`);
            await response.json();
          }
          apiKey = value; verified = true; lastError = ''; return json(res, 200, {ok: true});
        }
        if (path === '/api/forget-key' && req.method === 'POST') {
          if (active) return json(res, 409, {error: '请先结束会议。'});
          apiKey = ''; verified = false; return json(res, 200, {ok: true});
        }
        if (path === '/api/test-backend' && req.method === 'POST') {
          if (backendTest?.state === 'running') return json(res, 409, {error: '后台测试正在进行。'});
          const controller = new AbortController(); backendTest = {state: 'running', controller};
          const current = backendTest; const timer = setTimeout(() => controller.abort(), 90000);
          run({sessionId: 'connection-test', delegationId: randomBytes(8).toString('hex'), purpose: 'task', context: [], objective: '连接自检：不要联网、不要读取任何文件，只回复“后台连接成功”。'}, {signal: controller.signal, reportProgress: () => true})
            .then(result => { current.state = result.includes('成功') ? 'passed' : 'failed'; })
            .catch(error => {current.state = 'failed'; current.error = error.message;})
            .finally(() => clearTimeout(timer));
          return json(res, 202, {ok: true});
        }
        if (path === '/api/stop' && req.method === 'POST') {await active?.stop('会议已结束'); return json(res, 200, {ok: true});}
        if (path === '/api/shutdown' && req.method === 'POST') {if (vexa.state().active) await vexa.stop(); json(res, 200, {ok: true}); setTimeout(() => close(), 100); return;}
        return json(res, 404, {error: '接口不存在。'});
      } catch (error) { return json(res, error.status || 400, {error: error.name === 'TimeoutError' ? '连接 MOSS 超时，请检查网络。' : error.message === 'fetch failed' ? '无法连接 MOSS，请检查网络或代理设置。' : error.message}); }
    }
    if (req.method !== 'GET') return json(res, 405, {error: 'METHOD_NOT_ALLOWED'});
    const name = path === '/' ? 'index.html' : path === '/vexa' ? 'vexa.html' : path.slice(1);
    if (!assets.has(name)) return json(res, 404, {error: 'NOT_FOUND'});
    try {
      const data = await readFile(join(ROOT, 'public', name));
      const type = name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
      res.writeHead(200, {'Content-Type': type, 'Cache-Control': 'no-store', 'Set-Cookie': `moss_meeting=${cookie}; HttpOnly; SameSite=Strict; Path=/`, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'"});
      res.end(data);
    } catch {json(res, 500, {error: '无法读取本机界面文件。'});}
  });
  server.on('upgrade', (req, socket, head) => {
    const reject = code => socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\n\r\n`);
    if (closed || req.headers.host !== authority || req.headers.origin !== `http://${authority}` || !authorized(req) || req.url !== '/connect') return reject(403);
    if (active) return reject(409);
    if (!apiKey) return reject(401);
    wss.handleUpgrade(req, socket, head, browser => {
      const upstream = new WebSocket(upstreamUrl, {headers: {Authorization: `Bearer ${apiKey}`}, followRedirects: false, handshakeTimeout: 20000, maxPayload: 16 * 1024 * 1024});
      const receipts = new Map();
      let bridge, ended = false, cleanup, attached = false;
      const timer = setTimeout(() => stop('MOSS 连接超时，请稍后重试。'), 25000);
      function send(value) {if (browser.readyState === WebSocket.OPEN) browser.send(JSON.stringify(value));}
      function diagnostic(message) { lastError = message; send({type: 'local.error', message}); }
      function stop(message = '') {
        if (ended) return cleanup; ended = true; clearTimeout(timer);
        if (message) diagnostic(message);
        upstream.terminate();
        if (browser.readyState === WebSocket.OPEN) browser.close(1000, '会议连接已结束');
        cleanup = Promise.resolve(bridge?.close()).catch(() => {lastError = '后台任务的停止状态待确认，请检查 Codex。';}).finally(() => {if (active?.socket === browser) active = null;});
        return cleanup;
      }
      active = {socket: browser, stop, get attached() {return attached;}};
      const taskSend = (id, status, title) => send({type: 'local.task', id, status, title});
      bridge = createDelegationBridge({run: async (task, context) => {
        metrics.taskCount++; taskSend(task.delegationId, 'running', task.purpose === 'reasoning' ? '整理讨论内容' : task.objective);
        try {
          const result = await run(task, {...context, reportProgress: (text, options) => {taskSend(task.delegationId, 'progress', text); return context.reportProgress(text, options);}});
          return result;
        } catch (error) {taskSend(task.delegationId, context.signal.aborted ? 'cancelled' : 'failed', context.signal.aborted ? '后台任务已取消' : error.message); throw error;}
      }, executionTimeoutMs: 180000, cancelGraceMs: 7000, send: frame => new Promise((resolve, reject) => {
        if (upstream.readyState !== WebSocket.OPEN) return reject(Error('CONNECTION_CLOSED'));
        if (frame.status !== 'in_progress') {receipts.set(frame.event_id, {id: frame.delegation_id, status: frame.status}); taskSend(frame.delegation_id, 'returning', '已完成查询，正在回传给小莫');}
        upstream.send(JSON.stringify(frame), error => error ? reject(error) : resolve());
      }), onError: error => {if (error.code !== 'EXECUTOR_FAILED') void stop(`后台连接异常：${error.code}`);}});
      upstream.on('open', () => {metrics.connections++; lastError = ''; upstream.send(JSON.stringify({action: 'attach_session', memory_scope: 'session', delegation: {type: 'client'}}));});
      upstream.on('unexpected-response', (_request, response) => {response.resume(); void stop(`MOSS 拒绝连接（HTTP ${response.statusCode}）。请检查 Key、实时模型权限和账户额度。`);});
      upstream.on('message', (bytes, binary) => {
        if (ended) return;
        try {
          if (binary) {metrics.audioOut++; if (browser.readyState === WebSocket.OPEN) browser.send(bytes, {binary: true}); return;}
          const raw = JSON.parse(bytes.toString()); metrics.lastEvent = raw.action || '';
          bridge.handle(raw);
          if (raw.action === 'session_attached') {attached = true; clearTimeout(timer);}
          if (raw.action === 'input.transcript.done') metrics.inputTurns++;
          if (raw.action === 'output.transcript.done') metrics.outputTurns++;
          if (raw.action === 'session.delegation.created') taskSend(raw.data?.delegation?.id, 'queued', '后台查询已排队');
          if (raw.action === 'session.delegation.cancelled') taskSend(raw.data?.delegation_id, 'cancelled', '后台任务已取消');
          if (raw.action?.endsWith('.appended')) {
            const receipt = receipts.get(raw.data?.client_event_id);
            if (receipt) {receipts.delete(raw.data.client_event_id); if (receipt.status === 'completed') metrics.tasksCompleted++; taskSend(receipt.id, receipt.status, receipt.status === 'completed' ? '结果已送达小莫' : '后台查询失败');}
          }
          const event = filterEvent(raw); if (event) send(event);
        } catch (error) { void stop(`实时协议处理失败：${error.code || 'INVALID_EVENT'}`); }
      });
      browser.on('message', (bytes, binary) => {
        if (ended) return;
        try {
          if (!attached || upstream.readyState !== WebSocket.OPEN) throw Error('NOT_ATTACHED');
          if (binary) {metrics.audioIn++; upstream.send(bytes, {binary: true});}
          else {
            const event = validateRequest(JSON.parse(bytes.toString()));
            if (!allowedActions.has(event.action)) throw Error('EVENT_NOT_ALLOWED');
            if (event.action.startsWith('playback.')) metrics.playbackReceipts++;
            upstream.send(JSON.stringify(event));
          }
        } catch { void stop('会话状态已变化，请结束后重新开始。'); }
      });
      upstream.on('error', error => void stop(`无法连接 MOSS：${error.code || 'NETWORK_ERROR'}。请检查网络。`));
      upstream.on('close', () => {if (!ended) void stop(attached ? 'MOSS 连接已断开，请重新开始会议。' : 'MOSS 未能建立会话，请检查密钥和实时模型权限。');});
      browser.on('error', () => void stop()); browser.on('close', () => void stop());
    });
  });
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(port, '127.0.0.1', resolve);});
  authority = `127.0.0.1:${server.address().port}`;
  async function close() {if (closed) return; closed = true; backendTest?.controller.abort(); vexa.close(); await active?.stop(); await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve));}
  return {url: `http://${authority}`, close, get metrics() {return {...metrics};}};
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const {boot} = await import('./start.mjs');
  await boot();
}
