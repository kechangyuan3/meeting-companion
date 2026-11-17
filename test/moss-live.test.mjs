import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudApp} from '../worker/index.js';
import {filterEvent} from '../runtime/public-api.mjs';
const origin='https://meeting.example';
const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
class Socket extends EventTarget{
  readyState=0;sent=[];
  accept(){this.readyState=1;}
  send(value){if(this.readyState!==1)throw Error('socket closed');this.sent.push(value);}
  emit(value){const e=new Event('message');Object.defineProperty(e,'data',{value});this.dispatchEvent(e);}
  json(value){this.emit(JSON.stringify(value));}
  end(code=1000,reason=''){if(this.readyState===3)return;this.readyState=3;const e=new Event('close');Object.defineProperties(e,{code:{value:code},reason:{value:reason}});this.dispatchEvent(e);}
  close(code,reason){this.end(code,reason);}
}
function timers(){
 let next=0;const timeouts=new Map(),intervals=new Map();
 return {timeouts,intervals,setTimeout(fn,ms){const id=++next;timeouts.set(id,{fn,ms});return id;},clearTimeout(id){timeouts.delete(id);},setInterval(fn,ms){const id=++next;intervals.set(id,{fn,ms});return id;},clearInterval(id){intervals.delete(id);},run(ms){const entry=[...timeouts].find(([,v])=>v.ms===ms);if(!entry)return false;timeouts.delete(entry[0]);entry[1].fn();return true;},pulse(){for(const job of [...intervals.values()])job.fn();}};
}
async function fixture(t){
 const pairs=[],remotes=[],requests=[],clock=timers();let replyStatus=101;
 const app=createCloudApp({liveTimers:clock,pairFactory:()=>{const pair={0:new Socket(),1:new Socket()};pairs.push(pair);return pair;},upgradeResponse:client=>({status:101,webSocket:client}),fetchImpl:async(url,options)=>{requests.push({url,options});if(replyStatus!==101)return {status:replyStatus};const remote=new Socket();remotes.push(remote);return {status:101,webSocket:remote};}});
 const connect=async(key='test-moss-alice-key')=>{await app.fetch(new Request(origin+'/connect',{headers:{Origin:origin,Upgrade:'websocket'}}));const socket=pairs.at(-1)[1];socket.json({action:'local.authenticate',apiKey:key});await flush();return socket;};
 t.after(()=>pairs.forEach(pair=>pair[1].close()));
 return {pairs,remotes,requests,clock,connect,status(value){replyStatus=value;},attach(remote=remotes.at(-1),id='original-session'){remote.json({action:'session_attached',data:{session_id:id,memory_scope:'session',delegation:'none'}});}};
}
test('handshake timeout is cleared after upgrade; established connections heartbeat without a one-minute timer',async t=>{
 const f=await fixture(t),browser=await f.connect();f.attach();
 assert.equal(f.clock.timeouts.size,0);assert.equal(f.clock.intervals.size,1);
 assert.equal(f.requests[0].options.signal.aborted,false);
 f.clock.pulse();assert.equal(JSON.parse(f.remotes[0].sent.at(-1)).action,'ping');
 assert.equal(browser.readyState,1);browser.close();assert.equal(f.clock.intervals.size,0);
});
test('session.closing forwards numeric codes and reconnect booleans',()=>{
 assert.deepEqual(filterEvent({action:'session.closing',data:{code:1012,reason:'service restart',reconnect:true,internal:'not public'}}),{action:'session.closing',data:{code:1012,reason:'service restart',reconnect:true}});
});
test('provider-approved recovery resumes the same session and key, drops gap audio and ignores stale sockets',async t=>{
 const f=await fixture(t),browser=await f.connect();f.attach();const old=f.remotes[0];
 old.json({action:'session.closing',data:{code:'restart',reason:'retry safely',reconnect:true}});old.end(1000);
 assert.equal(browser.readyState,1);assert.equal(JSON.parse(browser.sent.at(-1)).type,'local.reconnecting');
 const gap=new ArrayBuffer(12);browser.emit(gap);assert.equal(old.sent.includes(gap),false);
 assert.equal(f.clock.run(500),true);await flush();
 const next=f.remotes[1];assert.equal(f.requests[1].options.headers.Authorization,'Bearer test-moss-alice-key');
 assert.deepEqual(JSON.parse(next.sent[0]),{action:'attach_session',session_id:'original-session',memory_scope:'session',delegation:{type:'none'}});
 f.attach(next);const count=browser.sent.length;old.json({action:'input.transcript.done',data:{text:'stale old connection',turn:'1'}});assert.equal(browser.sent.length,count);
 const current=new ArrayBuffer(4);browser.emit(current);assert.equal(next.sent.at(-1),current);assert.equal(old.sent.includes(current),false);
});
test('non-recoverable closes preserve the reason and never retry or expose the key',async t=>{
 const f=await fixture(t),browser=await f.connect();f.attach();
 f.remotes[0].json({action:'session.closing',data:{code:1008,reason:'policy: test-moss-alice-key',reconnect:false}});f.remotes[0].end(1008);
 assert.equal(browser.readyState,3);assert.equal(f.clock.timeouts.size,0);assert.equal(f.requests.length,1);
 const output=browser.sent.join('\n');assert.match(output,/1008/);assert.doesNotMatch(output,/test-moss-alice-key/);
});
test('closing the browser during a pending recovery cancels only that visitor',async t=>{
 const f=await fixture(t),browser=await f.connect();f.attach();f.remotes[0].end(1006);
 browser.close();assert.equal(f.clock.run(500),false);await flush();assert.equal(f.requests.length,1);assert.equal(f.clock.intervals.size,0);
});
test('a runtime socket error closes the old transport before recovering',async t=>{
 const f=await fixture(t),browser=await f.connect();f.attach();f.remotes[0].dispatchEvent(new Event('error'));
 assert.equal(f.remotes[0].readyState,3);assert.equal(browser.readyState,1);assert.equal(f.clock.run(500),true);await flush();
 assert.equal(f.requests.length,2);assert.equal(JSON.parse(f.remotes[1].sent[0]).session_id,'original-session');
});
test('transient recovery handshake failures use a bounded retry budget',async t=>{
 const f=await fixture(t),browser=await f.connect();f.attach();f.status(503);f.remotes[0].end(1006);
 for(const ms of [500,1500,3500]){assert.equal(f.clock.run(ms),true);await flush();}
 assert.equal(f.requests.length,4);assert.equal(browser.readyState,3);assert.equal(f.clock.timeouts.size,0);
 assert.match(JSON.parse(browser.sent.at(-1)).message,/连续恢复失败/);
});
test('account policy or rate limits stop recovery instead of retrying indefinitely',async t=>{
 const f=await fixture(t),browser=await f.connect();f.attach();f.status(429);f.remotes[0].end(1006);f.clock.run(500);await flush();
 assert.equal(browser.readyState,3);assert.equal(f.requests.length,2);assert.equal(f.clock.timeouts.size,0);assert.match(JSON.parse(browser.sent.at(-1)).message,/429/);
});
test('an expired session does not silently create a new conversation',async t=>{
 const f=await fixture(t),browser=await f.connect();f.attach();f.remotes[0].end(1006);f.clock.run(500);await flush();
 f.remotes[1].json({action:'error',data:{error:{code:'unknown_session',message:'expired'}}});
 assert.equal(browser.readyState,3);assert.equal(f.requests.length,2);assert.match(JSON.parse(browser.sent.at(-1)).message,/原会话/);
});
test('recovery preserves visitor isolation across credentials and session IDs',async t=>{
 const f=await fixture(t),a=await f.connect('test-moss-alice-key');f.attach(f.remotes[0],'alice-session');
 const b=await f.connect('test-moss-bob-key');f.attach(f.remotes[1],'bob-session');
 f.remotes[0].end(1006);f.clock.run(500);await flush();
 assert.equal(f.requests[2].options.headers.Authorization,'Bearer test-moss-alice-key');assert.equal(JSON.parse(f.remotes[2].sent[0]).session_id,'alice-session');
 assert.equal(f.remotes[1].readyState,1);assert.equal(b.readyState,1);a.close();assert.equal(f.remotes[1].readyState,1);
});
