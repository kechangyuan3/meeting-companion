import assert from 'node:assert/strict';
import {progressText,MAX_PROGRESS_BYTES} from './progress.mjs';

/** Registers tests. Fixtures own test inputs and independent stop/isolation assertions. */
export function adapterContract(test, {createFixture, timeoutMs=10000, summarizeResult, maxProgressBytes=MAX_PROGRESS_BYTES}) {
  const within=(promise)=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('Adapter did not settle within the test timeout')),timeoutMs);
    Promise.resolve(promise).then(resolve,reject).finally(()=>clearTimeout(timer));
  });
  test('adapter: returns a nonempty final answer and bounded progress',async()=>{
    const f=await createFixture();const controller=new AbortController();
    try {
      let result=await within(f.run(f.task,{signal:controller.signal,limits:{maxProgressBytes,maxResultChars:2000},reportProgress:text=>{assert.notEqual(progressText(text,maxProgressBytes),null);return true;}}));
      if(typeof result==='string'&&Array.from(result).length>2000&&summarizeResult)result=await within(summarizeResult(result,f.task,{signal:controller.signal,maxChars:2000}));
      assert.equal(typeof result,'string');assert.ok(result.trim()&&Array.from(result).length<=2000);
      await f.assertCompleted(result);
    }finally{controller.abort();await within(f.cleanup());}
  });
  test('adapter: cancellation stops owned work before promise settles',async()=>{
    const f=await createFixture();const controller=new AbortController();
    try {
      // Observe rejection immediately; some SDKs reject synchronously on abort.
      let settled=false;
      const outcome=Promise.resolve().then(()=>f.run(f.longTask,{signal:controller.signal,reportProgress:()=>true})).then(()=>null,e=>e).finally(()=>{settled=true;});
      await within(f.waitStarted());assert.equal(settled,false,'longTask fixture must remain active until cancelled');controller.abort();await within(outcome);
      await f.assertStopped();
    }finally{controller.abort();await within(f.cleanup());}
  });
  test('adapter: separate fixtures do not share execution state',async()=>{
    const a=await createFixture(),b=await createFixture();const ca=new AbortController(),cb=new AbortController();
    try {
      await within(Promise.all([a.run(a.task,{signal:ca.signal,reportProgress:()=>true}),b.run(b.task,{signal:cb.signal,reportProgress:()=>true})]));
      await a.assertIsolatedFrom(b);
    }finally{ca.abort();cb.abort();await within(Promise.all([a.cleanup(),b.cleanup()]));}
  });
}

/** Opt-in: a real streaming fixture must hold completion until release(). */
export async function assertProgressContract(f, timeoutMs=10000) {
 let releaseSeen,late=false,settled=false;const seen=[];
 const controller=new AbortController();
 const reported=new Promise(resolve=>{releaseSeen=resolve});
 const within=async p=>{let timer;try{return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Progress was not observable before completion')),timeoutMs)})]);}finally{clearTimeout(timer)}};
 const running=Promise.resolve().then(()=>f.run(f.task,{signal:controller.signal,limits:{maxProgressBytes:f.maxProgressBytes??MAX_PROGRESS_BYTES,maxResultChars:2000},reportProgress:(text,options={})=>{
  if(settled)late=true;seen.push({text,options});releaseSeen();return true;
 }})).then(result=>({result}),error=>({error})).finally(()=>{settled=true;});
 try {
  const first=await within(Promise.race([reported.then(()=>true),running.then(()=>false)]));
  assert.equal(first,true,'runner must report progress while work remains');assert.equal(settled,false);
  await f.release();const outcome=await within(running);if(outcome.error)throw outcome.error;
  for(const {text,options} of seen){assert.notEqual(progressText(text,f.maxProgressBytes??MAX_PROGRESS_BYTES),null);assert.notEqual(options.spoken,true,'automatic progress must not force speech');}
  assert.ok(seen.length>0);await f.assertProgress(seen.map(x=>x.text),outcome.result);
 } finally {controller.abort();try {await f.release();await within(running);} finally {await f.cleanup();}}
 assert.equal(late,false,'progress after completion');
}
