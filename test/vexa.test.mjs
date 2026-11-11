import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createVexaClient, parseMeetingUrl} from '../vexa-client.mjs';
import {startMeeting} from '../server.mjs';

const key = 'vexa-test-secret-not-real';
async function fixture() {
  const calls = []; let transcript = {status: 'active', segments: []}; let rejectDelete = false;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    calls.push({path: req.url, method: req.method, headers: req.headers, body: body ? JSON.parse(body) : null});
    const reply = (status, data) => {res.writeHead(status, {'Content-Type': 'application/json'}); res.end(JSON.stringify(data));};
    if (req.headers['x-api-key'] !== key) return reply(401, {detail: 'Invalid key'});
    if (req.url === '/meetings?limit=1') return reply(200, {meetings: []});
    if (req.url === '/bots' && req.method === 'POST') return reply(201, {id: 123, platform: 'google_meet', native_meeting_id: 'abc-defg-hij', status: 'requested'});
    if (req.url.startsWith('/transcripts/')) return reply(transcript.httpStatus || 200, transcript);
    if (req.url.startsWith('/bots/') && req.method === 'DELETE') {
      if (rejectDelete) return reply(503, {detail: key});
      transcript.status = 'completed'; return reply(200, {status: 'stopping'});
    }
    reply(404, {detail: 'not found'});
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return {calls, baseUrl: `http://127.0.0.1:${server.address().port}`, setTranscript: value => {transcript = value;}, rejectDelete: value => {rejectDelete = value;}, close: () => new Promise(resolve => server.close(resolve))};
}

test('meeting links keep embedded credentials and reject lookalike/unrecognized hosts', () => {
  const zoom = parseMeetingUrl('https://us02web.zoom.us/j/81234567890?pwd=join-pass');
  assert.equal(zoom.platform, 'zoom'); assert.equal(zoom.nativeMeetingId, '81234567890'); assert.match(zoom.meetingUrl, /pwd=join-pass/);
  assert.equal(parseMeetingUrl('https://meet.google.com/abc-defg-hij').platform, 'google_meet');
  assert.equal(parseMeetingUrl('https://teams.microsoft.com/meet/397421056486982?p=pass').nativeMeetingId, '397421056486982');
  assert.equal(parseMeetingUrl('https://teams.microsoft.com/l/meetup-join/19%3ameeting_abcd%40thread.v2/0?context=example').nativeMeetingId, '19:meeting_abcd@thread.v2');
  for (const url of ['http://meet.google.com/abc-defg-hij', 'https://zoom.us.attacker.example/j/81234567890', 'https://zoom.us@attacker.example/j/81234567890', 'https://127.0.0.1/private', 'https://zoom.us/j/not-an-id', 'https://teams.microsoft.com/l/meetup-join/%E0%A4/0']) assert.throws(() => parseMeetingUrl(url));
});

test('cloud auth, join, confirmed transcript replacement, summary snapshot, stop: complete HTTP lifecycle', async () => {
  const f = await fixture(); let task;
  const client = createVexaClient({baseUrl: f.baseUrl, run: async value => {task = value; return '结论：周五提交。待办：Alice 提交草案。';}});
  try {
    assert.equal((await client.configure(key)).busy, false); await assert.rejects(client.configure('wrong-test-key'), /无效/);
    assert.equal(client.state().configured, true);
    assert.equal((await client.start({meetingUrl: 'https://meet.google.com/abc-defg-hij', language: 'zh'})).busy, false);
    const spawn = f.calls.find(row => row.method === 'POST');
    assert.equal(spawn.body.meeting_url, 'https://meet.google.com/abc-defg-hij'); assert.equal(spawn.body.transcribe_enabled, true); assert.equal(spawn.body.recording_enabled, false); assert.equal(spawn.body.language, 'zh');
    assert.equal(spawn.headers['x-api-key'], key); assert.equal(spawn.headers.authorization, undefined);
    await assert.rejects(client.forget(), /退出/); await assert.rejects(client.start({meetingUrl: 'https://meet.google.com/abc-defg-hij'}), /退出/);
    f.setTranscript({status: 'active', segments: [{segment_id: '1', speaker: '', start: 1, text: '周五提', completed: false}]});
    await client.poll(); assert.equal(client.state().meeting.segments[0].speaker, '未识别发言者');
    assert.throws(() => client.summarize(), /已确认/);
    f.setTranscript({status: 'active', segments: [{segment_id: '1', speaker: 'Alice', start: 1, text: '周五提交草案', completed: true}, {segment_id: '1', start: 1, text: '周五提', completed: false}, {segment_id: '2', speaker: 'Bob', start: 4, text: '稍后再说', completed: false}]});
    await client.poll(); assert.equal(client.state().meeting.segments.length, 2); assert.equal(client.state().meeting.segments[0].text, '周五提交草案');
    client.summarize();
    for (let i = 0; i < 30 && client.state().summary.state === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(client.state().summary.state, 'completed'); assert.match(task.objective, /Alice：周五提交草案/); assert.doesNotMatch(task.objective, /稍后再说/); assert.doesNotMatch(JSON.stringify(task), /vexa-test-secret/);
    await client.stop(); await client.poll(); assert.equal(client.state().active, false);
    assert.equal(f.calls.find(row => row.method === 'DELETE').path, '/bots/google_meet/abc-defg-hij');
    assert.equal(f.calls.some(row => row.method === 'DELETE' && row.path.startsWith('/meetings/')), false);
    assert.doesNotMatch(JSON.stringify(client.state()), /vexa-test-secret/);
    await client.forget(); assert.equal(client.state().configured, false);
  } finally {client.close(); await f.close();}
});

test('pending transcript is visible; failed stop keeps the bot active and does not leak remote error payloads', async () => {
  const f = await fixture(); const client = createVexaClient({baseUrl: f.baseUrl});
  try {
    await client.configure(key); await client.start({meetingUrl: 'https://meet.google.com/abc-defg-hij'});
    f.setTranscript({httpStatus: 404}); await client.poll(); assert.match(client.state().meeting.lastError, /尚未生成/);
    f.rejectDelete(true); await assert.rejects(client.stop(), /尚未就绪/); assert.equal(client.state().active, true); assert.doesNotMatch(JSON.stringify(client.state()), /vexa-test-secret/);
    f.rejectDelete(false); await client.stop();
  } finally {client.close(); await f.close();}
});

test('Vexa local routes require loopback cookie and origin; unconfigured UI cannot join', async () => {
  const f = await fixture(); const app = await startMeeting({port: 0, run: async () => 'test summary', vexaBaseUrl: f.baseUrl});
  try {
    const page = await fetch(`${app.url}/vexa`); assert.equal(page.status, 200); assert.match(await page.text(), /Vexa API Key/);
    const cookie = page.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(`${app.url}/api/vexa/status`)).status, 403);
    assert.equal((await fetch(`${app.url}/api/vexa/configure`, {method: 'POST', headers: {Cookie: cookie, Origin: 'https://attacker.example'}, body: JSON.stringify({apiKey: key})})).status, 403);
    const post = (path, value) => fetch(`${app.url}/api/vexa/${path}`, {method: 'POST', headers: {Cookie: cookie, Origin: app.url, 'Content-Type': 'application/json'}, body: JSON.stringify(value)});
    assert.equal((await post('start', {meetingUrl: 'https://meet.google.com/abc-defg-hij'})).status, 409); assert.equal(f.calls.length, 0);
    assert.equal((await post('configure', {apiKey: key})).status, 200);
    const status = await (await fetch(`${app.url}/api/vexa/status`, {headers: {Cookie: cookie}})).json(); assert.equal(status.configured, true); assert.doesNotMatch(JSON.stringify(status), /vexa-test-secret/);
    assert.equal((await post('start', {meetingUrl: 'https://attacker.example/meeting'})).status, 400);
  } finally {await app.close(); await f.close();}
});
