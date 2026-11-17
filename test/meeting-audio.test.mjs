import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudApp} from '../worker/index.js';
import {meetingSpeechRequest} from '../runtime/moss-recap.mjs';
const origin = 'https://meeting.example';
const json = data => new Response(JSON.stringify(data), {headers: {'Content-Type': 'application/json'}});
const post = (app, path, data, {key = 'visitor-fixture-key', from = origin, type = 'application/json', model} = {}) => app.fetch(new Request(origin + path, {method: 'POST', headers: {Origin: from, Authorization: 'Bearer ' + key, 'Content-Type': type, ...(model ? {'X-Transcribe-Model': model} : {})}, body: type === 'application/json' ? JSON.stringify(data) : data}));

test('standard ASR sends no unsupported diarization or keyterms and retains text-only results', async () => {
  const calls = [];
  const app = createCloudApp({fetchImpl: async (url, init) => {
    calls.push({url, init});
    return json(url.includes('/tasks/') ? {status: 'SUCCESS', text: '合成测试转写，无真实会议。'} : {task_id: 'fixture-task'});
  }});
  const uploaded = await post(app, '/api/moss/transcribe', new Uint8Array([1, 2]), {type: 'audio/mpeg', model: 'moss-transcribe-1.0'});
  assert.equal(uploaded.status, 200);
  const form = calls[0].init.body;
  assert.equal(form.get('model'), 'moss-transcribe-1.0');assert.equal(form.has('diarize'), false);assert.equal(form.has('keyterms'), false);assert.equal(form.get('async'), 'true');
  assert.equal(form.get('file').name, 'meeting.mp3');
  const result = await (await post(app, '/api/moss/task', {taskId: 'fixture-task'})).json();
  assert.equal(result.text, '合成测试转写，无真实会议。');assert.deepEqual(result.segments, []);
  assert.equal((await post(app, '/api/moss/transcribe', new Uint8Array([1]), {type: 'audio/mpeg', model: 'unapproved-model'})).status, 400);
  assert.equal(calls.length, 2);
});

test('narration validates model, voice and bounded text before any paid API call', () => {
  const valid = {text: '测试结论。', voiceId: 'voice_fixture', model: 'moss-tts-1.5-flash'};
  assert.deepEqual(meetingSpeechRequest({...valid, webhook_url: 'https://untrusted.invalid', url: 'http://localhost'}), {model: valid.model, input: valid.text, voice_id: valid.voiceId, stream: false, response_format: 'mp3', delivery_method: 'audio'});
  for (const change of [{model: 'nex-n2.6'}, {voiceId: 'https://untrusted.invalid'}, {text: ''}, {text: 'x'.repeat(5001)}]) assert.throws(() => meetingSpeechRequest({...valid, ...change}));
});

test('voices and MP3 use each caller key, filter voice metadata, and never fetch returned URLs', async () => {
  const calls = [];
  const app = createCloudApp({fetchImpl: async (url, init) => {
    calls.push({url, init});
    if (url.includes('/voices')) return json({data: [{id: 'voice_fixture', name: '<b>测试音色</b>', internal_secret: 'not-for-browser'}, {id: 'https://untrusted.invalid', name: 'bad'}], has_more: true});
    return new Response(new Uint8Array([73, 68, 51, 0]), {headers: {'Content-Type': 'audio/mpeg'}});
  }});
  const [voices, speech] = await Promise.all([
    post(app, '/api/moss/voices', {}, {key: 'alice-fixture-key'}),
    post(app, '/api/moss/speech', {model: 'moss-tts-1.0-pro', text: '仅测试。', voiceId: 'voice_fixture'}, {key: 'bob-fixture-key'}),
  ]);
  assert.deepEqual(await voices.json(), {voices: [{id: 'voice_fixture', name: '<b>测试音色</b>'}], hasMore: true});
  assert.equal(speech.status, 200);assert.equal(speech.headers.get('Content-Type'), 'audio/mpeg');assert.equal(speech.headers.get('Cache-Control'), 'no-store');assert.equal(speech.headers.get('X-Meeting-Model'), 'moss-tts-1.0-pro');
  assert.deepEqual([...new Uint8Array(await speech.arrayBuffer())], [73, 68, 51, 0]);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer alice-fixture-key');assert.equal(calls[1].init.headers.Authorization, 'Bearer bob-fixture-key');
  assert.equal(JSON.parse(calls[1].init.body).delivery_method, 'audio');
  assert.ok(calls.every(call => call.url.startsWith('https://api.mosi.cn/v1/audio/') && call.init.redirect === 'manual'));
  assert.equal((await post(app, '/api/moss/speech', {text: 'x', voiceId: 'voice_fixture'}, {from: 'https://untrusted.invalid'})).status, 403);
  assert.equal(calls.length, 2);
  const bad = createCloudApp({fetchImpl: async () => json({url: 'https://untrusted.invalid/audio.mp3'})});
  assert.equal((await post(bad, '/api/moss/speech', {text: 'x', voiceId: 'voice_fixture'})).status, 502);
});
