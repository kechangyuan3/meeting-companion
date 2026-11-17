import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudApp} from '../worker/index.js';
import {startMeeting} from '../server.mjs';
import {recapSummaryRequest, recapSummaryText, recapTask, RecapError} from '../runtime/moss-recap.mjs';
import {createRecap} from '../cloud/public/recap.js';

const origin = 'https://meeting.example';
const encoder = new TextEncoder();
const sse = (events, done = true) => new ReadableStream({start(controller) {
  const text = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : '');
  // 故意切成小块，覆盖跨块拼接。
  for (let index = 0; index < text.length; index += 7) controller.enqueue(encoder.encode(text.slice(index, index + 7)));
  controller.close();
}});
const chunk = (content, reasoning) => ({object: 'chat.completion.chunk', choices: [{index: 0, delta: {...(content ? {content} : {}), ...(reasoning ? {reasoning_content: reasoning} : {})}}]});
const reply = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}});

test('short recordings show seconds instead of rounding every session up to one minute', t => {
  const now=1800000000000;t.mock.method(Date,'now',()=>now);
  const nodes=new Map(),$=id=>{if(!nodes.has(id))nodes.set(id,{replaceChildren(){}});return nodes.get(id);};
  let requests=0;const recap=createRecap({$,request:()=>{requests++;}});
  recap.ready([new Blob(['fixture'])],{startedAt:now-25000},{auto:false});
  assert.match($('recap-note').textContent,/已录音 25 秒/);assert.doesNotMatch($('recap-note').textContent,/1 分钟/);
  recap.ready([new Blob(['fixture'])],{startedAt:now-125000},{auto:false});
  assert.match($('recap-note').textContent,/已录音 2 分 5 秒/);assert.equal(requests,0);
});

// 模拟 MOSS 开放平台的三个接口。
function fakeMoss(seen) {
  return async (url, options) => {
    seen.push({url, ...options});
    if (url.endsWith('/v1/audio/transcriptions')) return reply({id: 'task_123', task_id: 'task_123', object: 'audio.transcription', status: 'PENDING', retry_after: 2});
    if (url.endsWith('/v1/audio/tasks/task_123')) return reply({id: 'task_123', object: 'audio.transcription', status: 'SUCCESS', text: '我们周五上线。好的。', segments: [{speaker: 'S01', start: 0.5, end: 3.2, text: '我们周五上线。'}, {speaker: 'S02', start: 3.4, end: 4, text: '好的。'}, {speaker: 'S02', start: 4, end: 4.1, text: '   '}]});
    if (url.endsWith('/v1/chat/completions')) return new Response(sse([chunk(null, '先想一想'), chunk('## 会议概要\n'), chunk('周五上线。')]), {headers: {'Content-Type': 'text/event-stream'}});
    return reply({error: {code: 'not_found'}}, 404);
  };
}

test('summary stream keeps only the final answer, across chunk boundaries', async () => {
  let text = ''; for await (const part of recapSummaryText(sse([chunk(null, '推理'), chunk('甲'), chunk('乙')]))) text += part;
  assert.equal(text, '甲乙');
  await assert.rejects(async () => {for await (const part of recapSummaryText(sse([chunk('半截')], false))) void part;}, RecapError);
});

test('summary request uses Nex N2.6, keeps speaker labels and refuses empty input', () => {
  const body = recapSummaryRequest({segments: [{speaker: 'S01', start: 65, text: '预算定在十万'}], conversation: [{who: 'ai', text: '好的，我记下了'}], assistantName: '小莫'});
  assert.equal(body.model, 'nex-n2.6'); assert.equal(body.stream, true);
  assert.match(body.messages[1].content, /\[01:05\] S01：预算定在十万/); assert.match(body.messages[1].content, /小莫：好的，我记下了/);
  assert.throws(() => recapSummaryRequest({segments: [], conversation: []}), RecapError);
  assert.deepEqual(recapTask({status: 'FAILED', error: {message: '音频损坏'}}).error, '音频损坏');
});

test('online worker relays recap calls to MOSS with the caller key only', async () => {
  const seen = []; const app = createCloudApp({fetchImpl: fakeMoss(seen)});
  const audio = new Uint8Array(4096).fill(1);
  const upload = await app.fetch(new Request(origin + '/api/moss/transcribe', {method: 'POST', headers: {Origin: origin, Authorization: 'Bearer key-for-alice', 'Content-Type': 'audio/webm', 'X-Keyterms': encodeURIComponent(JSON.stringify(['小莫', 'MOSS']))}, body: audio}));
  assert.equal(upload.status, 200); assert.deepEqual(await upload.json(), {taskId: 'task_123', status: 'PENDING', retryAfter: 2});
  const form = seen[0].body;
  assert.equal(seen[0].headers.Authorization, 'Bearer key-for-alice');
  assert.equal(form.get('model'), 'moss-transcribe-diarize-pro'); assert.equal(form.get('diarize'), 'true'); assert.equal(form.get('async'), 'true');
  assert.deepEqual(JSON.parse(form.get('keyterms')), ['小莫', 'MOSS']); assert.equal(form.get('file').size, 4096); assert.equal(form.get('file').type, 'audio/webm');

  const task = await (await app.fetch(new Request(origin + '/api/moss/task', {method: 'POST', headers: {Origin: origin, Authorization: 'Bearer key-for-alice', 'Content-Type': 'application/json'}, body: JSON.stringify({taskId: 'task_123'})}))).json();
  assert.equal(task.status, 'SUCCESS'); assert.equal(task.segments.length, 2); assert.equal(task.segments[1].speaker, 'S02');

  const summary = await app.fetch(new Request(origin + '/api/moss/summary', {method: 'POST', headers: {Origin: origin, Authorization: 'Bearer key-for-alice', 'Content-Type': 'application/json'}, body: JSON.stringify({segments: task.segments, conversation: [], assistantName: '小莫'})}));
  assert.equal(summary.status, 200); assert.equal(await summary.text(), '## 会议概要\n周五上线。');
  const chat = seen.at(-1); assert.match(chat.url, /\/v1\/chat\/completions$/); assert.equal(JSON.parse(chat.body).model, 'nex-n2.6');
  assert.ok(seen.every(call => call.url.startsWith('https://api.mosi.cn/') && call.headers.Authorization === 'Bearer key-for-alice'));
});

test('online worker rejects foreign origins, missing keys, bad formats, bad task ids and oversized audio before calling MOSS', async () => {
  const seen = []; const app = createCloudApp({fetchImpl: fakeMoss(seen)});
  const post = (path, {from = origin, key = 'key-for-alice', type = 'audio/webm', body = new Uint8Array(4096), length} = {}) => app.fetch(new Request(origin + path, {method: 'POST', headers: {Origin: from, ...(key ? {Authorization: 'Bearer ' + key} : {}), 'Content-Type': type, ...(length ? {'Content-Length': String(length)} : {})}, body}));
  assert.equal((await post('/api/moss/transcribe', {from: 'https://attacker.example'})).status, 403);
  assert.equal((await post('/api/moss/transcribe', {key: ''})).status, 401);
  assert.equal((await post('/api/moss/transcribe', {type: 'text/html'})).status, 415);
  assert.equal((await post('/api/moss/transcribe', {length: 50 * 1024 * 1024})).status, 413);
  assert.equal((await post('/api/moss/task', {type: 'application/json', body: JSON.stringify({taskId: '../../v1/models'})})).status, 400);
  assert.equal((await post('/api/moss/summary', {type: 'application/json', body: JSON.stringify({segments: []})})).status, 400);
  assert.equal(seen.length, 0);
});

test('local server serves the recap assets and relays recap calls with the stored key', async () => {
  const seen = [];
  const app = await startMeeting({port: 0, verifyKey: async () => {}, run: async () => '', mossFetch: fakeMoss(seen)});
  try {
    const root = await fetch(app.url); const cookie = root.headers.get('set-cookie').split(';')[0];
    for (const asset of ['/recap.js', '/media/recorder.js']) assert.equal((await fetch(app.url + asset)).status, 200);
    const post = (path, body, type = 'application/json') => fetch(app.url + path, {method: 'POST', headers: {Cookie: cookie, Origin: app.url, 'Content-Type': type}, body});
    assert.equal((await post('/api/moss/transcribe', new Uint8Array(4096), 'audio/webm')).status, 401, 'no key configured yet');
    assert.equal((await post('/api/configure', JSON.stringify({apiKey: 'local-secret-key-123456'}))).status, 200);
    const created = await (await post('/api/moss/transcribe', new Uint8Array(4096), 'audio/ogg')).json();
    assert.equal(created.taskId, 'task_123'); assert.equal(seen[0].headers.Authorization, 'Bearer local-secret-key-123456');
    assert.equal(seen[0].body.get('file').type, 'audio/ogg');
    const task = await (await post('/api/moss/task', JSON.stringify({taskId: created.taskId}))).json();
    assert.equal(task.segments[0].text, '我们周五上线。');
    const summary = await post('/api/moss/summary', JSON.stringify({segments: task.segments, conversation: [{who: 'user', text: '周五可以吗'}]}));
    assert.equal(await summary.text(), '## 会议概要\n周五上线。');
    assert.equal((await fetch(app.url + '/api/moss/task', {method: 'POST', headers: {Cookie: cookie, Origin: 'https://untrusted.invalid', 'Content-Type': 'application/json'}, body: '{}'})).status, 403);
  } finally {await app.close();}
});
