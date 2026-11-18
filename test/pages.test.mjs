import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve,basename} from 'node:path';
import {buildPages} from '../scripts/build-pages.mjs';
import {serviceUrls} from '../cloud/public/service-base.js';
import {createCloudApp} from '../worker/index.js';

test('Pages frontend sends API and both voice sockets to the configured backend, independent of repository subpath',()=>{
  const urls=serviceUrls('https://voice.example','https://kechangyuan3.github.io');
  assert.equal(urls.api('/api/moss/ask'),'https://voice.example/api/moss/ask');
  assert.equal(urls.socket('/connect-xf'),'wss://voice.example/connect-xf');
  assert.equal(urls.socket('/connect'),'wss://voice.example/connect');
  assert.equal(serviceUrls('','http://127.0.0.1:17864').socket('/connect'),'ws://127.0.0.1:17864/connect');
  for(const path of ['https://other.example','//other.example','/api/x?key=secret'])assert.throws(()=>urls.api(path));
});

test('Pages build retains the actual UI, all relative assets, worker module and explicitly marked demo',async()=>{
  const out=await mkdtemp(join(tmpdir(),'meeting-pages-test-'));
  try{
    await buildPages({out,backend:'https://voice.example'});
    const files=(await readdir(out,{recursive:true})).map(name=>name.replaceAll('\\','/'));
    const index=await readFile(join(out,'index.html'),'utf8');
    assert.match(index,/GitHub Pages/);assert.match(index,/id="nex-assistant"/);assert.match(index,/id="audio-tools"/);
    assert.doesNotMatch(index,/(?:src|href)="\/(?!\/)/);
    assert.match(await readFile(join(out,'service-config.js'),'utf8'),/https:\/\/voice\.example/);
    assert.match(await readFile(join(out,'demo/index.html'),'utf8'),/不会录音、调用 API/);
    assert.ok(files.includes('media/capture-worklet.js'));
    assert.ok(files.includes('.nojekyll'));
    for(const file of files.filter(name=>/\.(html|js|css)$/.test(name))){
      const text=await readFile(join(out,file),'utf8');
      const references=file.endsWith('.html')?[...text.matchAll(/(?:src|href)="(\.\/[^"#?]+)"/g)].map(match=>match[1]):file.endsWith('.js')?[...text.matchAll(/(?:from\s+|import\s*)['"](\.\/[^'"]+)['"]/g)].map(match=>match[1]):[];
      for(const reference of references){const path=resolve(dirname(join(out,file)),reference.endsWith('/')?reference+'index.html':reference);await readFile(path);}
      assert.doesNotMatch(text,/sk-[a-f0-9]{32,}/i);
    }
  }finally{assert.equal(dirname(resolve(out)),resolve(tmpdir()));assert.ok(basename(out).startsWith('meeting-pages-test-'));await rm(out,{recursive:true,force:true});}
});

test('GitHub Pages preflight, success and error responses allow only the configured origin without shared credentials',async()=>{
  const origin='https://kechangyuan3.github.io',base='https://backend.example';let calls=0;
  const app=createCloudApp({additionalOrigins:[origin],fetchImpl:async(_url,init)=>{calls++;assert.equal(init.headers.Authorization,'Bearer visitor-fixture-key');return Response.json({data:[]});}});
  const preflight=from=>new Request(base+'/api/moss/verify',{method:'OPTIONS',headers:{Origin:from,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,content-type,x-transcribe-model'}});
  const allowed=await app.fetch(preflight(origin));assert.equal(allowed.status,204);assert.equal(allowed.headers.get('Access-Control-Allow-Origin'),origin);assert.equal(calls,0);
  assert.equal((await app.fetch(preflight('https://other-user.github.io'))).status,403);
  const response=await app.fetch(new Request(base+'/api/moss/verify',{method:'POST',headers:{Origin:origin,Authorization:'Bearer visitor-fixture-key','Content-Type':'application/json'},body:'{}'}));
  assert.equal(response.status,200);assert.equal(response.headers.get('Access-Control-Allow-Origin'),origin);assert.equal(response.headers.get('Access-Control-Allow-Credentials'),null);assert.equal(calls,1);
  const failed=await app.fetch(new Request(base+'/api/moss/ask',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'}));
  assert.equal(failed.status,401);assert.equal(failed.headers.get('Access-Control-Allow-Origin'),origin);assert.equal(calls,1);
});

test('GitHub Pages voice upgrades preserve the WebSocket response and reject another account origin',async()=>{
  class Socket extends EventTarget{readyState=1;accept(){}send(){}close(){if(this.readyState===3)return;this.readyState=3;this.dispatchEvent(new Event('close'));}}
  let pairs=0,server;
  const app=createCloudApp({additionalOrigins:['https://kechangyuan3.github.io'],pairFactory:()=>{pairs++;return {0:new Socket(),1:(server=new Socket())};},upgradeResponse:client=>({status:101,webSocket:client})});
  const connect=origin=>new Request('https://backend.example/connect-xf',{headers:{Origin:origin,Upgrade:'websocket'}});
  assert.equal((await app.fetch(connect('https://other-user.github.io'))).status,403);assert.equal(pairs,0);
  const response=await app.fetch(connect('https://kechangyuan3.github.io'));assert.equal(response.status,101);assert.ok(response.webSocket);server.close();
});
