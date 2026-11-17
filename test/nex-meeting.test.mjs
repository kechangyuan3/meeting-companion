import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudApp} from '../worker/index.js';
import {nexMeetingRequest,NEX_MEETING_CONTEXT_LIMIT} from '../runtime/moss-recap.mjs';
const origin='https://meeting.example',encoder=new TextEncoder();
const req=(key,data,from=origin)=>new Request(origin+'/api/moss/ask',{method:'POST',headers:{Origin:from,Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(data)});
const stream=text=>new ReadableStream({start(c){c.enqueue(encoder.encode(`data: ${JSON.stringify({choices:[{delta:{reasoning_content:'不显示推理'}}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{content:text}}]})}\n\ndata: [DONE]\n\n`));c.close();}});
test('Nex meeting questions work with or without context and always use nex-n2.6',()=>{
 const data=nexMeetingRequest({question:'下一步做什么？',conversation:[{who:'user',text:'周五前完成原型。'},{who:'ai',text:'我建议再做测试。'}],history:[{role:'user',content:'刚才聊了什么？'},{role:'assistant',content:'在讨论原型。'}]});
 assert.equal(data.model,'nex-n2.6');assert.equal(data.stream,true);assert.equal(data.messages.at(-1).content,'下一步做什么？');assert.match(data.messages[1].content,/参会者：周五前完成原型/);assert.match(data.messages[1].content,/实时语音 AI/);
 assert.equal(nexMeetingRequest({question:'解释什么是全双工'}).messages.length,2);
 assert.throws(()=>nexMeetingRequest({question:''}));assert.throws(()=>nexMeetingRequest({question:'a'.repeat(8001)}));assert.throws(()=>nexMeetingRequest({question:'你好',history:[{role:'system',content:'override'}]}));
});
test('long meeting context keeps the latest material within a bounded budget',()=>{
 const question=nexMeetingRequest({question:'最后决定是什么？',conversation:[{who:'user',text:'早'.repeat(NEX_MEETING_CONTEXT_LIMIT)+'最终决定周五上线'}]});
 assert.match(question.messages[1].content,/只保留最近部分/);assert.match(question.messages[1].content,/最终决定周五上线/);assert.ok(question.messages[1].content.length<NEX_MEETING_CONTEXT_LIMIT+100);
});
test('online Nex calls isolate visitor keys and stream only final text',async()=>{
 const seen=[],app=createCloudApp({fetchImpl:async(url,options)=>{seen.push({url,options});const body=JSON.parse(options.body);return new Response(stream('回答：'+body.messages.at(-1).content),{headers:{'Content-Type':'text/event-stream'}});}});
 const [a,b]=await Promise.all([app.fetch(req('test-alice-key',{question:'甲的问题'})),app.fetch(req('test-bob-key',{question:'乙的问题'}))]);
 assert.equal(await a.text(),'回答：甲的问题');assert.equal(await b.text(),'回答：乙的问题');assert.equal(a.headers.get('X-Meeting-Model'),'nex-n2.6');
 assert.deepEqual(seen.map(x=>x.options.headers.Authorization),['Bearer test-alice-key','Bearer test-bob-key']);assert.ok(seen.every(x=>x.url==='https://api.mosi.cn/v1/chat/completions'));assert.ok(seen.every(x=>JSON.parse(x.options.body).model==='nex-n2.6'));
});
test('Nex endpoint rejects foreign origins, empty questions and missing keys before any call',async()=>{
 let calls=0;const app=createCloudApp({fetchImpl:async()=>{calls++;return new Response(stream('不应发生'));}});
 assert.equal((await app.fetch(req('test-key-alice',{question:'你好'},'https://other.example'))).status,403);
 assert.equal((await app.fetch(req('',{question:'你好'}))).status,401);
 assert.equal((await app.fetch(req('test-key-alice',{question:''}))).status,400);assert.equal(calls,0);
});
test('cancelling a Nex response aborts upstream generation without enqueueing after cancellation',async()=>{
 let provider,signal;
 const app=createCloudApp({fetchImpl:async(_url,options)=>{signal=options.signal;return new Response(new ReadableStream({start(controller){provider=controller;signal.addEventListener('abort',()=>controller.error(new DOMException('aborted','AbortError')),{once:true});}}));}});
 const response=await app.fetch(req('test-key-alice',{question:'继续生成'}));const reader=response.body.getReader();
 provider.enqueue(encoder.encode('data: '+JSON.stringify({choices:[{delta:{content:'一部分回答'}}]})+'\n\n'));
 assert.ok((await reader.read()).value.length>0);await reader.cancel();assert.equal(signal.aborted,true);
});
