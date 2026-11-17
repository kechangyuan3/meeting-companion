import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createCloudApp} from '../worker/index.js';
import {xfSignedUrl, xfFrame, xfParse, xfCredentials, xfOptions} from '../runtime/xf-live.mjs';
import {XfLink, textOf, iatResult} from '../cloud/public/xf-link.js';

const origin = 'https://meeting.example';
const creds = {appId: 'a1b2c3d4', apiKey: '0123456789abcdef0123456789abcdef', apiSecret: 'NjQ3YzMxMjk4ZjM1MTM0MDY0MDRmNDhk'};
const b64 = text => Buffer.from(text).toString('base64');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('讯飞签名与官方通用鉴权一致，URL 只带 authorization、date、host', async () => {
  const date = 'Mon, 16 Nov 2026 08:00:00 GMT';
  const url = new URL(await xfSignedUrl(creds, date));
  assert.equal(url.origin + url.pathname, 'https://sparkos.xfyun.cn/v1/openapi/chat');
  assert.deepEqual([...url.searchParams.keys()], ['authorization', 'date', 'host']);
  assert.equal(url.searchParams.get('date'), date); assert.equal(url.searchParams.get('host'), 'sparkos.xfyun.cn');
  const expected = createHmac('sha256', creds.apiSecret).update(`host: sparkos.xfyun.cn\ndate: ${date}\nGET /v1/openapi/chat HTTP/1.1`).digest('base64');
  const authorization = Buffer.from(url.searchParams.get('authorization'), 'base64').toString();
  assert.equal(authorization, `api_key="${creds.apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${expected}"`);
  assert.doesNotMatch(url.href, new RegExp(creds.apiSecret));
});

test('请求帧：首帧带识别、对话、合成参数，之后只带音频；全双工、stmid 固定', () => {
  const options = xfOptions({voice: 'x5_lingfeiyi_flow', prompt: '你叫小莫', uid: 'mc-1'});
  const audio = new Uint8Array([1, 2, 3, 4]);
  const first = xfFrame(xfCredentials(creds), options, {status: 0, audio});
  assert.equal(first.header.app_id, creds.appId); assert.equal(first.header.interact_mode, 'continuous'); assert.equal(first.header.stmid, '1');
  assert.equal(first.parameter.nlp.new_session, 'true'); assert.equal(first.parameter.nlp.prompt, '你叫小莫'); assert.equal(first.parameter.tts.vcn, 'x5_lingfeiyi_flow');
  assert.equal(first.parameter.tts.tts.sample_rate, 24000);
  assert.deepEqual([...Buffer.from(first.payload.audio.audio, 'base64')], [1, 2, 3, 4]);
  assert.equal(first.payload.audio.sample_rate, 16000);
  const middle = xfFrame(creds, options, {status: 1, audio});
  assert.equal(middle.parameter, undefined); assert.equal(middle.payload.audio.status, 1);
  assert.equal(xfFrame(creds, xfOptions({resume: true}), {status: 0}).parameter.nlp.new_session, 'false');
  assert.equal(xfOptions({voice: 'evil', uid: '../x'}).voice, 'x5_lingxiaoyue_flow');
  assert.throws(() => xfCredentials({appId: 'a/b', apiKey: creds.apiKey, apiSecret: creds.apiSecret}));
});

test('讯飞回复拆成字幕事件和 PCM；页面端能拼出听写和回复文字', () => {
  const {event, audio} = xfParse(JSON.stringify({header: {code: 0, status: 1}, payload: {
    event: {text: b64('{"event":"Bos"}')},
    iat: {text: b64(JSON.stringify({sn: 2, pgs: 'rpl', rg: [1, 1], ls: true, ws: [{cw: [{w: '小莫'}]}, {cw: [{w: '你好'}]}]})), status: 2},
    nlp: {text: b64('{"text":"好的"}'), status: 0}, tts: {audio: Buffer.from([0, 1, 2, 3]).toString('base64'), status: 0, seq: 1, sample_rate: 24000}}}));
  assert.match(event.event, /Bos/); assert.equal(textOf(event.nlp), '好的'); assert.equal(event.tts.rate, 24000); assert.deepEqual([...audio], [0, 1, 2, 3]);
  assert.deepEqual(iatResult(event.iat), {sn: 2, pgs: 'rpl', rg: [1, 1], ls: true, text: '小莫你好'});
  assert.equal(textOf('纯文字'), '纯文字');
});

class Socket extends EventTarget {
  readyState = 0; sent = [];
  accept() {this.readyState = 1;}
  send(value) {this.sent.push(value);}
  close() {if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close'));}
  emit(value) {const event = new Event('message'); Object.defineProperty(event, 'data', {value}); this.dispatchEvent(event);}
}

test('在线版 /connect-xf：各自签名、PCM 包成讯飞帧、回复转成字幕和音频，密钥不回传页面', async () => {
  const pairs = [], remotes = [], urls = [], ready = Promise.withResolvers(); let accepted = 0;
  class ReadySocket extends Socket {accept() {super.accept(); if (++accepted === 2) ready.resolve();}}
  const app = createCloudApp({pairFactory: () => {const pair = {0: new Socket(), 1: new Socket()}; pairs.push(pair); return pair;}, upgradeResponse: client => ({status: 101, webSocket: client}),
    fetchImpl: async (url, options) => {assert.equal(options.headers.Upgrade, 'websocket'); urls.push(url); const remote = new ReadySocket(); remotes.push(remote); return {status: 101, webSocket: remote};}});
  const connect = () => app.fetch(new Request(origin + '/connect-xf', {headers: {Origin: origin, Upgrade: 'websocket'}}));
  await connect(); await connect();
  pairs[0][1].emit(JSON.stringify({action: 'local.authenticate', ...creds, voice: 'x5_lingxiaoyue_flow', prompt: '你叫小莫', uid: 'alice'}));
  pairs[1][1].emit(JSON.stringify({action: 'local.authenticate', ...creds, appId: 'bob12345', uid: 'bob'}));
  await ready.promise;
  assert.equal(urls.length, 2); assert.ok(urls.every(url => url.startsWith('https://sparkos.xfyun.cn/v1/openapi/chat?authorization=')));
  assert.deepEqual(JSON.parse(pairs[0][1].sent[0]), {type: 'xf.ready'});
  pairs[0][1].emit(new Uint8Array([9, 9]).buffer); pairs[0][1].emit(new Uint8Array([8, 8]).buffer);
  const frames = remotes[0].sent.map(value => JSON.parse(value));
  assert.equal(frames[0].header.status, 0); assert.equal(frames[0].header.uid, 'alice'); assert.equal(frames[0].parameter.nlp.prompt, '你叫小莫');
  assert.equal(frames[1].header.status, 1); assert.equal(frames[1].parameter, undefined);
  assert.equal(remotes[1].sent.length, 0);
  remotes[0].emit(JSON.stringify({header: {code: 0, status: 1}, payload: {nlp: {text: b64('好的'), status: 0}, tts: {audio: Buffer.from([5, 6]).toString('base64'), status: 0, sample_rate: 24000}}}));
  const toPage = pairs[0][1].sent.slice(1);
  assert.equal(JSON.parse(toPage[0]).nlp, '好的'); assert.deepEqual([...new Uint8Array(toPage[1])], [5, 6]);
  assert.doesNotMatch(pairs[0][1].sent.filter(value => typeof value === 'string').join(''), new RegExp(creds.apiSecret));
  remotes[1].emit(JSON.stringify({header: {code: 10110, message: 'server licence error', status: 2}}));
  assert.match(JSON.parse(pairs[1][1].sent.at(-1)).message, /超拟人交互/); assert.equal(pairs[1][1].readyState, 3);
  pairs[0][1].close();
  assert.equal(JSON.parse(remotes[0].sent.at(-1)).header.status, 2); assert.equal(remotes[0].readyState, 3);
});

test('在线版 /connect-xf 拒绝外站、未认证的音频和格式不对的密钥，且不发起连接', async () => {
  let calls = 0; const pairs = [];
  const app = createCloudApp({pairFactory: () => {const pair = {0: new Socket(), 1: new Socket()}; pairs.push(pair); return pair;}, upgradeResponse: client => ({status: 101, webSocket: client}), fetchImpl: async () => {calls++; return {status: 101, webSocket: new Socket()};}});
  assert.equal((await app.fetch(new Request(origin + '/connect-xf', {headers: {Origin: 'https://attacker.example', Upgrade: 'websocket'}}))).status, 403);
  await app.fetch(new Request(origin + '/connect-xf', {headers: {Origin: origin, Upgrade: 'websocket'}}));
  pairs[0][1].emit(new Uint8Array([1]).buffer); assert.equal(pairs[0][1].readyState, 3);
  await app.fetch(new Request(origin + '/connect-xf', {headers: {Origin: origin, Upgrade: 'websocket'}}));
  pairs[1][1].emit(JSON.stringify({action: 'local.authenticate', appId: 'x', apiKey: 'y', apiSecret: 'z'})); await tick();
  assert.match(JSON.parse(pairs[1][1].sent.at(-1)).message, /APPID/); assert.equal(calls, 0);
});

test('在线版 /api/xf/verify：发送业务测试音频，握手成功不再等于服务已授权', async () => {
  class Confirmed extends Socket {send(value) {super.send(value);if(JSON.parse(value).header.status===0)this.emit(JSON.stringify({header:{code:0,status:0,message:'connect success'}}));}}
  let status = 101; const app = createCloudApp({fetchImpl: async () => status === 101 ? {status, webSocket: new Confirmed()} : new Response(null, {status})});
  const verify = data => app.fetch(new Request(origin + '/api/xf/verify', {method: 'POST', headers: {Origin: origin, 'Content-Type': 'application/json'}, body: JSON.stringify(data)}));
  assert.deepEqual(await (await verify(creds)).json(), {ok: true,serviceVerified:true,probeMs:3000});
  status = 401; const rejected = await verify(creds); assert.equal(rejected.status, 502); assert.match((await rejected.json()).error, /APISecret/);
  assert.equal((await verify({appId: 'a1b2'})).status, 400);
});

test('讯飞握手后返回 11200 的业务授权错误，验证必须失败且密钥不回显',async()=>{
 class Denied extends Socket {
  send(value){
   super.send(value);const frame=JSON.parse(value);
   if(frame.header.status===0){
    queueMicrotask(()=>this.emit(JSON.stringify({header:{code:0,message:'connect success'}})));
    queueMicrotask(()=>{const bytes=new TextEncoder().encode(JSON.stringify({header:{code:11200,message:'appId没有授权或者tokens超过限制'}}));this.emit(bytes.buffer);});
   }
  }
 }
 const app=createCloudApp({fetchImpl:async()=>({status:101,webSocket:new Denied()})});
 const response=await app.fetch(new Request(origin+'/api/xf/verify',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(creds)}));
 assert.equal(response.status,403);const text=await response.text();assert.match(text,/11200/);assert.match(text,/超拟人交互/);assert.doesNotMatch(text,new RegExp(creds.apiSecret));
});

test('讯飞握手后关闭的原因包含真实秒数，不再泛称达到 30 分钟',async()=>{
 const accepted=Promise.withResolvers();class ReadySocket extends Socket{accept(){super.accept();accepted.resolve();}}
 const pairs=[],remote=new ReadySocket();const app=createCloudApp({pairFactory:()=>{const pair={0:new Socket(),1:new Socket()};pairs.push(pair);return pair;},upgradeResponse:client=>({status:101,webSocket:client}),fetchImpl:async()=>({status:101,webSocket:remote})});
 await app.fetch(new Request(origin+'/connect-xf',{headers:{Origin:origin,Upgrade:'websocket'}}));pairs[0][1].emit(JSON.stringify({action:'local.authenticate',...creds}));await accepted.promise;remote.close();
 const message=JSON.parse(pairs[0][1].sent.at(-1)).message;assert.match(message,/秒后关闭/);assert.doesNotMatch(message,/最长 30 分钟/);
});

test('页面端 XfLink：29 分钟续连时先接好新连接再切换，旧连接收到结束通知', async () => {
  const sockets = [];
  globalThis.WebSocket = class {static OPEN = 1; readyState = 1; bufferedAmount = 0; sent = []; constructor(url) {this.url = url; sockets.push(this); queueMicrotask(() => this.onopen?.());} send(value) {this.sent.push(value);} close() {this.readyState = 3; this.onclose?.();}};
  const ctx = {currentTime: 0, destination: {}, createGain: () => ({gain: {setTargetAtTime() {}}, connect() {}, disconnect() {}})};
  const auth = [], events = {ready: 0, error: []};
  const link = new XfLink({ctx, url: 'wss://site/connect-xf', options: {uid: 'u1'}, authenticate: (ws, options) => auth.push(options),
    on: {ready: () => events.ready++, user() {}, ai() {}, speaking() {}, error: message => events.error.push(message)}});
  link.start(); await tick();
  sockets[0].onmessage({data: JSON.stringify({type: 'xf.ready'})});
  assert.equal(events.ready, 1); assert.equal(auth[0].resume, false);
  link.sendAudio(new ArrayBuffer(4)); assert.equal(sockets[0].sent.length, 1);
  link.renew(); await tick(); assert.equal(auth[1].resume, true);
  link.sendAudio(new ArrayBuffer(4)); assert.equal(sockets[1].sent.length, 0, '新连接就绪前，音频仍发往旧连接');
  sockets[1].onmessage({data: JSON.stringify({type: 'xf.ready'})});
  assert.deepEqual(JSON.parse(sockets[0].sent.at(-1)), {action: 'local.end'});
  link.sendAudio(new ArrayBuffer(4)); assert.equal(sockets[1].sent.length, 1);
  assert.equal(events.ready, 1); assert.deepEqual(events.error, []);
  link.close(); delete globalThis.WebSocket;
});
