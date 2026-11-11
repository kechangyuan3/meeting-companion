import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';
import {createProgressSink,MAX_PROGRESS_BYTES} from './progress.mjs';

const length = value => Array.from(value).length;
export class LiveError extends Error {
  constructor(code) { super(code); this.name='LiveError'; this.code=code; }
}
const error = code => new LiveError(code);
const bounded = (value, min, max, name) => {
  if (!Number.isSafeInteger(value) || value<min || value>max) throw error(`INVALID_${name}`);
  return value;
};
const validText = value => typeof value==='string' && value.trim() && length(value)<=2000;

/** One bridge belongs to one live session and never starts or reconnects a socket. */
export function createDelegationBridge(options) {
  const {run,send,onError=()=>{}}=options;
  if (typeof run!=='function' || typeof send!=='function') throw error('RUN_AND_SEND_REQUIRED');
  const concurrency=bounded(options.maxConcurrency??1,1,Number.MAX_SAFE_INTEGER,'CONCURRENCY');
  const maxQueue=bounded(options.maxQueue??8,0,Number.MAX_SAFE_INTEGER,'QUEUE');
  const timeout=bounded(options.executionTimeoutMs??600000,0,2147483647,'TIMEOUT');
  const cancelGrace=bounded(options.cancelGraceMs??5000,1,2147483647,'CANCEL_GRACE');
  const ackTimeout=bounded(options.ackTimeoutMs??15000,1,2147483647,'ACK_TIMEOUT');
  const maxProgressBytes=bounded(options.maxProgressBytes??MAX_PROGRESS_BYTES,1,Number.MAX_SAFE_INTEGER,'PROGRESS_LIMIT');
  const capacity=(value,fallback,name)=>value===null?Infinity:bounded(value??fallback,1,Number.MAX_SAFE_INTEGER,name);
  const maxPendingWrites=capacity(options.maxPendingWrites,256,'PENDING_CAPACITY');
  const maxTaskRecords=capacity(options.maxTaskRecords,4096,'TASK_CAPACITY');
  if(options.summarizeResult!==undefined&&typeof options.summarizeResult!=='function')throw error('INVALID_SUMMARIZER');
  const limits=Object.freeze({maxProgressBytes,maxResultChars:2000});
  let sessionId=options.sessionId,closed=false,active=0,chain=Promise.resolve(),closePromise;
  const entries=new Map(),queue=[],pending=new Map(),idle=new Set();
  const notify=code=>{try {onError(error(code));} catch { /* Observer errors must not interrupt cleanup. */ }};
  const clearPending=()=>{for(const p of pending.values())clearTimeout(p.timer);pending.clear();};
  const wake=()=>{if(active===0 && queue.length===0){for(const resolve of idle)resolve();idle.clear();}};
  function stop(e) {
    if(e.cancelled)return;
    e.cancelled=true;
    e.controller.abort(error('TASK_CANCELLED'));
    for(const [id,p] of pending)if(p.entry===e){clearTimeout(p.timer);pending.delete(id);}
    if(e.settled || !e.started){e.settled=true;return;}
    e.cancelTimer=setTimeout(()=>{if(!e.settled)fatal('CANCELLATION_UNCONFIRMED');},cancelGrace);
  }
  function fatal(code) {
    if(closed)return;
    closed=true;clearPending();for(const e of entries.values())stop(e);
    queue.length=0;wake();notify(code);
  }
  function append(e,content,status='in_progress',spoken=false) {
    if(closed || e.cancelled || e.final)return false;
    if(!validText(content))throw error('OUTPUT_MUST_BE_1_TO_2000_CHARACTERS');
    if(pending.size>=maxPendingWrites){fatal('DELIVERY_CAPACITY');return false;}
    if(status!=='in_progress')e.final=true;
    const id=randomUUID();
    const frame={action:spoken?'session.commentary.append':'session.thinking.append',event_id:id,delegation_id:e.task.delegationId,content,status};
    const record={entry:e,timer:setTimeout(()=>fatal('DELIVERY_UNCONFIRMED'),ackTimeout)};
    pending.set(id,record);
    chain=chain.then(async()=>{
      if(closed || e.cancelled){clearTimeout(record.timer);pending.delete(id);return;}
      await send(frame);
    }).catch(()=>fatal('DELIVERY_FAILED'));
    return true;
  }
  function pump() {
    while(!closed && active<concurrency && queue.length){
      const e=queue.shift();if(e.cancelled)continue;
      active++;e.started=true;
      e.timer=timeout===0?undefined:setTimeout(()=>{
        if(e.cancelled)return;
        append(e,'Task exceeded the execution time limit.','failed',true);
        // Preserve the failure delivery while stopping the executor.
        e.timedOut=true;e.controller.abort(error('EXECUTION_TIMEOUT'));
        e.cancelTimer=setTimeout(()=>{if(!e.settled)fatal('CANCELLATION_UNCONFIRMED');},cancelGrace);
      },timeout);
      e.promise=Promise.resolve().then(()=>{
        if(e.controller.signal.aborted)throw e.controller.signal.reason;
        return run(e.task,{signal:e.controller.signal,limits,reportProgress:createProgressSink((text,{spoken=false}={})=>append(e,text,'in_progress',spoken),()=>!e.controller.signal.aborted&&!e.settled&&!closed,maxProgressBytes)});
      }).then(async result=>{
        if(e.controller.signal.aborted)return;
        if(typeof result==='string'&&length(result)>2000&&options.summarizeResult){
          result=await options.summarizeResult(result,e.task,{signal:e.controller.signal,maxChars:2000});
        }
        if(!e.controller.signal.aborted)append(e,result,'completed',true);
      }).catch(()=>{
        if(!e.controller.signal.aborted){notify('EXECUTOR_FAILED');append(e,'Task execution failed.','failed',true);}
      }).finally(()=>{
        e.settled=true;clearTimeout(e.timer);clearTimeout(e.cancelTimer);active--;pump();wake();
      });
    }
    wake();
  }
  function handle(frame) {
    if(closed)return false;
    if(!frame || typeof frame!=='object')throw error('INVALID_EVENT');
    const data=frame.data??{};
    if(frame.action==='session_attached'){
      if(typeof data.session_id!=='string' || !data.session_id || data.delegation!=='client')throw error('CLIENT_DELEGATION_REQUIRED');
      if(sessionId && sessionId!==data.session_id)throw error('SESSION_CHANGED');
      sessionId=data.session_id;return true;
    }
    if(frame.action==='session.delegation.created'){
      if(!sessionId)throw error('SESSION_NOT_ATTACHED');
      if(typeof data.delegation?.id!=='string' || !data.delegation.id || data.delegation.id.length>256 || (data.delegation.target!==undefined && data.delegation.target!=='client') || typeof data.objective!=='string' || !data.objective.trim() || length(data.objective)>2000 || !['task','reasoning'].includes(data.purpose) || (data.context!==undefined && !Array.isArray(data.context)))throw error('INVALID_DELEGATION');
      const context=(data.context??[]).map(line=>{
        if(!line || typeof line.role!=='string' || line.role.length>64 || typeof line.content!=='string' || length(line.content)>600)throw error('INVALID_CONTEXT');
        return Object.freeze({role:line.role,content:line.content});
      });
      if(context.length>6)throw error('INVALID_CONTEXT');
      const task=Object.freeze({sessionId,delegationId:data.delegation.id,objective:data.objective,purpose:data.purpose,context:Object.freeze(context)});
      const signature=JSON.stringify(task),old=entries.get(task.delegationId);
      if(old){if(old.signature!==signature)throw error('DELEGATION_CONFLICT');return true;}
      // Retain tombstones for the whole bridge lifetime; never silently replay a task.
      if(entries.size>=maxTaskRecords){fatal('SESSION_TASK_CAPACITY');return true;}
      const e={task,signature,controller:new AbortController(),started:false,settled:false,cancelled:false,final:false};
      entries.set(task.delegationId,e);
      if(active>=concurrency && queue.length>=maxQueue){append(e,'Task queue is full.','failed',true);e.settled=true;return true;}
      queue.push(e);pump();return true;
    }
    if(frame.action==='session.delegation.cancelled'){
      const e=entries.get(data.delegation_id);if(e)stop(e);
      for(let i=queue.length-1;i>=0;i--)if(queue[i].cancelled)queue.splice(i,1);
      pump();return true;
    }
    if(['session.thinking.appended','session.commentary.appended'].includes(frame.action) || frame.action==='error'){
      const id=frame.action==='error'?data.error?.client_event_id:data.client_event_id;
      const p=pending.get(id);if(!p)return false;
      clearTimeout(p.timer);pending.delete(id);
      if(frame.action==='error')fatal('DELIVERY_REJECTED');
      return true;
    }
    return false;
  }
  return {
    handle,
    get sessionId(){return sessionId;},
    get closed(){return closed;},
    get stats(){return {active,queued:queue.length,pending:pending.size,tasks:entries.size};},
    async flush(){await chain;},
    whenIdle(){return active===0 && queue.length===0?Promise.resolve():new Promise(resolve=>idle.add(resolve));},
    close(){
      if(closePromise)return closePromise;
      closed=true;clearPending();for(const e of entries.values())stop(e);queue.length=0;wake();
      closePromise=new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{notify('CANCELLATION_UNCONFIRMED');reject(error('CANCELLATION_UNCONFIRMED'));},cancelGrace);
        this.whenIdle().then(()=>{clearTimeout(timer);resolve();});
      });
      return closePromise;
    }
  };
}

/** Attach to an existing Node ws connection. Media listeners continue to work. */
export function attachDelegation({socket,...options}) {
  if(!socket || typeof socket.on!=='function' || typeof socket.off!=='function')throw error('NODE_WS_SOCKET_REQUIRED');
  const bridge=createDelegationBridge({...options,send:frame=>new Promise((resolve,reject)=>{
    if(socket.readyState!==WebSocket.OPEN){reject(error('CONNECTION_CLOSED'));return;}
    socket.send(JSON.stringify(frame),failure=>failure?reject(error('SEND_FAILED')):resolve());
  })});
  const report=code=>{try {options.onError?.(error(code));}catch{}};
  const onMessage=(bytes,binary)=>{
    if(binary)return;
    try {bridge.handle(JSON.parse(bytes.toString()));}
    catch {report('INVALID_PUBLIC_EVENT');void bridge.close().catch(()=>{});}
  };
  const onClose=()=>{void bridge.close().catch(()=>{});};
  const onError=()=>{report('CONNECTION_FAILED');onClose();};
  socket.on('message',onMessage);socket.on('close',onClose);socket.on('error',onError);
  const close=bridge.close.bind(bridge);
  bridge.close=()=>{
    socket.off('message',onMessage);socket.off('close',onClose);socket.off('error',onError);
    return close();
  };
  return bridge;
}

/** Open the application's single live connection, attach client delegation and return it. */
export async function connectLive({url,apiKey,model,user,sessionId=null,memoryScope,connectTimeoutMs=15000,...options}) {
  const address=new URL(url);
  if((address.protocol!=='wss:' && !(address.protocol==='ws:' && ['localhost','127.0.0.1','[::1]'].includes(address.hostname))) || address.username || address.password || address.search || address.hash)throw error('PUBLIC_WSS_URL_REQUIRED');
  if(typeof apiKey!=='string' || !apiKey || /[\r\n]/.test(apiKey))throw error('API_KEY_REQUIRED');
  bounded(connectTimeoutMs,1,2147483647,'CONNECT_TIMEOUT');
  if(model)address.searchParams.set('model',model);
  if(user)address.searchParams.set('user',user);
  const preflight=createDelegationBridge({...options,send:()=>{}});
  await preflight.close();
  const socket=new WebSocket(address,{headers:{Authorization:`Bearer ${apiKey}`},followRedirects:false,maxPayload:16*1024*1024,handshakeTimeout:connectTimeoutMs});
  const bridge=attachDelegation({socket,sessionId:sessionId??undefined,...options});
  try {
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>finish(error('ATTACH_TIMEOUT')),connectTimeoutMs);
      const finish=failure=>{clearTimeout(timer);socket.off('message',message);socket.off('error',failed);socket.off('close',ended);failure?reject(failure):resolve();};
      const failed=()=>finish(error('CONNECTION_FAILED'));
      const ended=()=>finish(error('CONNECTION_CLOSED'));
      const message=(bytes,binary)=>{
        if(binary)return;
        try {const frame=JSON.parse(bytes.toString());
          if(frame.action==='session_attached')finish(bridge.sessionId && !bridge.closed?null:error('CLIENT_DELEGATION_REQUIRED'));
          else if(frame.action==='error')finish(error('ATTACH_REJECTED'));
        }catch{finish(error('INVALID_PUBLIC_EVENT'));}
      };
      socket.on('message',message);socket.on('error',failed);socket.on('close',ended);
      socket.once('open',()=>socket.send(JSON.stringify({action:'attach_session',session_id:sessionId,delegation:{type:'client'},...(memoryScope?{memory_scope:memoryScope}:{})})));
    });
  }catch(failure){socket.terminate();await bridge.close().catch(()=>{});throw failure;}
  const dispose=bridge.close.bind(bridge);
  return {socket,bridge,sessionId:bridge.sessionId,async close(){socket.close();await dispose();}};
}
