import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudApp} from '../worker/index.js';
const origin='https://meeting.example';
const req=(path,key,data={},from=origin)=>new Request(origin+path,{method:'POST',headers:{Origin:from,Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(data)});
const reply=(value,status=200)=>new Response(JSON.stringify(value),{status});
test('cloud callers own their credentials; concurrent Vexa calls never use another visitor key',async()=>{
  const seen=[];
  const app=createCloudApp({fetchImpl:async(url,options)=>{
    seen.push({url,...options});const key=options.headers['X-API-Key'];
    if(url.endsWith('/meetings?limit=1'))return reply({meetings:[{private:'not exposed'}]});
    if(url.includes('/transcripts/'))return reply({status:'active',segments:[{segment_id:'1',speaker:key==='key-for-alice'?'Alice':'Bob',text:'本人的会议',start:1,completed:true}]});
    if(options.method==='DELETE')return reply({ok:true});
    return reply({id:1,status:'requested'});
  }});
  const [a,b]=await Promise.all(['key-for-alice','key-for-bob'].map(key=>app.fetch(req('/api/vexa/verify',key)).then(r=>r.json())));
  assert.deepEqual(a,{ok:true});assert.deepEqual(b,{ok:true});
  const [ta,tb]=await Promise.all(['key-for-alice','key-for-bob'].map(key=>app.fetch(req('/api/vexa/poll',key,{platform:'google_meet',nativeMeetingId:'abc-defg-hij'})).then(r=>r.json())));
  assert.equal(ta.segments[0].speaker,'Alice');assert.equal(tb.segments[0].speaker,'Bob');
  await app.fetch(req('/api/vexa/stop','key-for-alice',{platform:'google_meet',nativeMeetingId:'abc-defg-hij'}));
  assert.match(seen.at(-1).url,/\/bots\/google_meet\/abc-defg-hij$/);assert.equal(seen.at(-1).method,'DELETE');
  assert.equal(seen.at(-1).headers['X-API-Key'],'key-for-alice');assert.doesNotMatch(JSON.stringify([a,b,ta,tb]),/key-for-/);
});
test('cloud rejects foreign origins, missing credentials, malformed bodies and arbitrary target URLs',async()=>{
  let calls=0;const app=createCloudApp({fetchImpl:async()=>{calls++;return reply({ok:true});}});
  assert.equal((await app.fetch(req('/api/vexa/verify','key-for-alice',{},'https://attacker.example'))).status,403);
  assert.equal((await app.fetch(req('/api/vexa/verify',''))).status,400);
  assert.equal((await app.fetch(req('/api/vexa/start','key-for-alice',{meetingUrl:'https://127.0.0.1/private'}))).status,400);
  assert.equal((await app.fetch(req('/api/vexa/poll','key-for-alice',{platform:'google_meet',nativeMeetingId:'../../users'}))).status,400);
  assert.equal((await app.fetch(req('/api/moss/verify','key-for-alice',null))).status,400);
  assert.equal(calls,0);
});
test('Worker fetch accepts manual redirects and never forwards credentials to a redirect destination',async()=>{
  let calls=0;const app=createCloudApp({fetchImpl:async(url,options)=>{
    if(options.redirect==='error')throw new TypeError('Workers does not implement redirect:error');
    calls++;assert.match(url,/^https:\/\/api\.cloud\.vexa\.ai\//);
    return new Response(null,{status:302,headers:{Location:'https://attacker.invalid/collect'}});
  }});
  const response=await app.fetch(req('/api/vexa/verify','key-for-alice'));assert.equal(response.status,502);assert.equal(calls,1);assert.doesNotMatch(await response.text(),/key-for-alice/);
});
class Socket extends EventTarget{
  readyState=0;sent=[];accept(){this.readyState=1;}send(value){this.sent.push(value);}close(){if(this.readyState===3)return;this.readyState=3;this.dispatchEvent(new Event('close'));}emit(value){const event=new Event('message');Object.defineProperty(event,'data',{value});this.dispatchEvent(event);}
}
test('cloud WebSockets isolate auth, relay actual binary frames, and cancel only the closing visitor',async()=>{
  const pairs=[],remotes=[],auth=[];
  const app=createCloudApp({pairFactory:()=>{const pair={0:new Socket(),1:new Socket()};pairs.push(pair);return pair;},upgradeResponse:client=>({status:101,webSocket:client}),fetchImpl:async(url,options)=>{assert.match(url,/^https:\/\/api\.mosi\.cn\/v1\/realtime/);auth.push(options.headers.Authorization);const remote=new Socket();remotes.push(remote);return {status:101,webSocket:remote};}});
  const connect=()=>app.fetch(new Request(origin+'/connect',{headers:{Origin:origin,Upgrade:'websocket'}}));
  await connect();await connect();
  pairs[0][1].emit(JSON.stringify({action:'local.authenticate',apiKey:'moss-alice-key'}));pairs[1][1].emit(JSON.stringify({action:'local.authenticate',apiKey:'moss-bob-key'}));
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.deepEqual(auth,['Bearer moss-alice-key','Bearer moss-bob-key']);
  assert.equal(JSON.parse(remotes[0].sent[0]).delegation.type,'none');
  for(const remote of remotes)remote.emit(JSON.stringify({action:'session_attached',data:{session_id:'own-session'}}));
  const input=new Uint8Array([1,2,3,4]).buffer,output=new Uint8Array([7,8,9]).buffer;
  pairs[0][1].emit(input);remotes[0].emit(output);
  assert.equal(remotes[0].sent.at(-1),input);assert.equal(pairs[0][1].sent.at(-1),output);
  assert.equal(remotes[1].sent.includes(input),false);assert.equal(pairs[1][1].sent.includes(output),false);
  pairs[0][1].close();assert.equal(remotes[0].readyState,3);assert.equal(remotes[1].readyState,1);
  pairs[1][1].close();
});

