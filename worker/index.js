import {VexaError,parseMeetingUrl,normalizeSegments} from '../vexa-shared.mjs';
import {validateRequest,filterEvent} from '../runtime/public-api.mjs';
import {recapRoute,RecapError} from '../runtime/moss-recap.mjs';
import {XfError,xfCredentials,xfOptions,xfSignedUrl,xfFrame,xfParse,xfErrorMessage} from '../runtime/xf-live.mjs';

const VEXA='https://api.cloud.vexa.ai';
const MOSS='https://api.mosi.cn';
const allowedActions=new Set(['media.mode','mic_state','playback.chunk.completed','playback.completed','playback.stopped','session.update','conversation.item.create','response.create','ping']);
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
function credential(value){const key=String(value||'').trim();if(key.length<8||key.length>4096||/[\r\n]/.test(key))throw new VexaError('请填写完整的 API Key。',400);return key;}
async function readBytes(request,limit=65536,ErrorType=VexaError){
  if(Number(request.headers.get('Content-Length'))>limit)throw new ErrorType('请求过大。',413);
  const reader=request.body?.getReader();if(!reader)return new Uint8Array();
  const chunks=[];let size=0;
  try {while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw new ErrorType('请求过大。',413);}chunks.push(value);}}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return bytes;
}
async function readBody(request,limit=65536,ErrorType=VexaError){
  const bytes=await readBytes(request,limit,ErrorType);
  try{return JSON.parse(new TextDecoder().decode(bytes)||'{}');}catch{throw new ErrorType('请求格式不正确。',400);}
}
function nativeKey(data){
  const platform=data.platform,id=String(data.nativeMeetingId||'');
  const valid=(platform==='google_meet'&&/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(id))||(platform==='zoom'&&/^\d{9,12}$/.test(id))||(platform==='teams'&&(/^(\d{10,15})$/.test(id)||/^19:meeting_[^/\s]{1,500}@thread\.v2$/.test(id)));
  if(!valid)throw new VexaError('会议标识不正确，请重新粘贴完整会议链接。',400);
  return {platform,id,tail:`${platform}/${encodeURIComponent(id)}`};
}

export function createCloudApp({fetchImpl=fetch,assets={},siteOrigin,additionalOrigins=[],pairFactory=()=>new WebSocketPair(),upgradeResponse=client=>new Response(null,{status:101,webSocket:client}),liveTimers={setTimeout,clearTimeout,setInterval,clearInterval}}={}){
  const originAllowed = request => [new URL(request.url).origin,siteOrigin,...additionalOrigins].filter(Boolean).includes(request.headers.get('Origin'));
  async function upstream(base,path,key,{method='GET',data}={}){
    let response;
    try{response=await fetchImpl(`${base}${path}`,{method,headers:{...(base===MOSS?{Authorization:`Bearer ${key}`}:{'X-API-Key':key}),...(data?{'Content-Type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{}),signal:AbortSignal.timeout(25000),redirect:'manual'});}
    catch{throw new VexaError(`无法连接 ${base===MOSS?'MOSS':'Vexa'}，请检查网络后重试。`,502);}
    if(response.status>=300&&response.status<400)throw new VexaError('服务返回了非预期跳转，连接已停止，请从官方控制台检查服务地址。',502);
    if(!response.ok){
      const provider=base===MOSS?'MOSS':'Vexa';
      const messages={401:`${provider} Key 无效，请从官方账户页复制完整密钥。`,402:`${provider} 账户额度不足。`,403:`${provider} 拒绝访问，请检查 Key 权限、额度和并发限制。`,404:'该会议的转写记录尚未生成，或该 Key 无权访问。',409:'该会议已有机器人或状态冲突，请检查服务控制台。',422:'会议参数不被接受，请检查完整邀请链接和入会密码。',429:'请求频率或并发数超过服务限制，请稍后重试。',503:'服务或转写引擎暂未就绪，请稍后重试。'};
      throw new VexaError(messages[response.status]||`${provider} 请求失败（HTTP ${response.status}）。`,response.status);
    }
    if(response.status===204)return {};
    let text;try{text=await response.text();if(!text)return {};if(text.length>8*1024*1024)throw Error();return JSON.parse(text);}catch{throw new VexaError('服务返回的数据格式异常或过大。',502);}
  }
  function connect(request){
    if(request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return json({error:'需要 WebSocket 连接。'},426);
    const [client,server]=Object.values(pairFactory());server.accept();server.binaryType='arraybuffer';
    let remote=null,state='waiting',attached=false,apiKey='',sessionId='',closing=null;
    let deadline=null,heartbeat=null,retryTimer=null,openingController=null,retries=0;
    const reconnectTimes=[];
    const send=value=>{try{if(server.readyState===1)server.send(JSON.stringify(value));}catch{}};
    const safeReason=value=>String(value??'').replaceAll(apiKey||'\u0000','[已隐藏密钥]').replace(/sk-[A-Za-z0-9_-]{12,}/gi,'[已隐藏密钥]').replace(/[\u0000-\u001f]/g,' ').slice(0,180);
    const stopHeartbeat=()=>{if(heartbeat!==null)liveTimers.clearInterval(heartbeat);heartbeat=null;};
    const finish=(message='',code=1000)=>{
      if(state==='closed')return;state='closed';attached=false;
      liveTimers.clearTimeout(deadline);liveTimers.clearTimeout(retryTimer);stopHeartbeat();openingController?.abort();
      if(message)send({type:'local.error',message});
      try{remote?.close(1000,'会话结束');}catch{}remote=null;apiKey='';
      try{server.close(code,'会话结束');}catch{}
    };
    const armDeadline=()=>{liveTimers.clearTimeout(deadline);deadline=liveTimers.setTimeout(()=>finish('实时会话建立超时；录音和字幕仍保留，请重新开始。',1008),30000);};
    function recover(){
      if(state==='closed'||retryTimer!==null)return;
      const now=Date.now();while(reconnectTimes.length&&now-reconnectTimes[0]>120000)reconnectTimes.shift();
      if(!sessionId||++retries>3||reconnectTimes.length>=5)return finish('MOSS 连接连续恢复失败；录音和字幕已保留，请检查网络或账户状态后重新开始。',1011);
      reconnectTimes.push(now);state='reconnecting';attached=false;stopHeartbeat();liveTimers.clearTimeout(deadline);
      send({type:'local.reconnecting',attempt:retries,message:'正在恢复 MOSS 语音连接，会议录音继续保留。'});
      retryTimer=liveTimers.setTimeout(()=>{retryTimer=null;if(state!=='closed')void openRemote(true);},[500,1500,3500][retries-1]);
    }
    async function openRemote(resume){
      if(state==='closed')return;
      state=resume?'reconnecting':'connecting';closing=null;
      // The deadline belongs only to the upgrade request, never to the accepted socket.
      const controller=new AbortController();openingController=controller;
      const handshake=liveTimers.setTimeout(()=>controller.abort(),25000);
      let response;
      try{response=await fetchImpl(`${MOSS}/v1/realtime?model=moss-live-1.0`,{headers:{Upgrade:'websocket',Authorization:`Bearer ${apiKey}`},redirect:'manual',signal:controller.signal});}
      catch{if(state!=='closed'){if(resume)recover();else finish('无法建立 MOSS 实时会话，请检查网络、Key、额度和服务状态。',1011);}return;}
      finally{liveTimers.clearTimeout(handshake);if(openingController===controller)openingController=null;}
      if(response.status!==101||!response.webSocket){
        if(resume&&![401,402,403,404,409,429].includes(response.status)){recover();return;}
        return finish(`MOSS 拒绝连接（HTTP ${response.status}），请检查 Key、模型权限和额度。`,1008);
      }
      const next=response.webSocket;
      if(state==='closed'){try{next.accept();next.close(1000,'页面连接已结束');}catch{}return;}
      remote=next;next.binaryType='arraybuffer';armDeadline();
      next.addEventListener('message',incoming=>{
        if(state==='closed'||remote!==next)return;
        try{
          if(typeof incoming.data!=='string'){if(attached&&server.readyState===1)server.send(incoming.data);return;}
          const raw=JSON.parse(incoming.data);
          if(raw.action==='session.closing'){
            const d=raw.data||{};closing={code:typeof d.code==='number'?d.code:safeReason(d.code),reason:safeReason(d.reason),reconnect:d.reconnect===true};
            raw.data=closing;
          }
          if(raw.action==='session_attached'){
            const id=raw.data?.session_id;if(typeof id!=='string'||!id||id.length>512)throw Error('invalid session');
            sessionId=id;attached=true;state='ready';retries=0;liveTimers.clearTimeout(deadline);stopHeartbeat();
            heartbeat=liveTimers.setInterval(()=>{if(state==='ready'&&remote===next&&next.readyState===1){try{next.send(JSON.stringify({action:'ping',timestamp:Date.now()}));}catch{finish('MOSS 连接保活失败；录音和字幕已保留，请重新开始。',1011);}}},15000);
          }
          if(resume&&raw.action==='error'&&/session|memory_scope/i.test(raw.data?.error?.code||''))return finish('MOSS 未能恢复原会话；录音和字幕已保留，请重新开始。',1008);
          const filtered=filterEvent(raw);if(filtered)send(filtered);
        }catch{finish('实时语音协议处理失败；录音和字幕已保留，请重新开始。',1011);}
      });
      next.addEventListener('close',event=>{
        if(state==='closed'||remote!==next)return;
        remote=null;attached=false;stopHeartbeat();liveTimers.clearTimeout(deadline);
        const code=closing?.code??event.code??1006,reason=closing?.reason||safeReason(event.reason);
        if(sessionId&&(closing?closing.reconnect:![1008,4001,4003,4029].includes(Number(code)))){recover();return;}
        finish(`MOSS 实时连接已关闭（${code}）${reason?'：'+reason:'。'} 录音和字幕已保留。`,1000);
      });
      next.addEventListener('error',()=>{
        if(state==='closed'||remote!==next)return;
        // Let the close event complete the old transport before attempting a resume.
        try{next.close(1011,'transport error');}catch{finish('MOSS 实时连接出现错误；录音和字幕已保留，请重新开始。',1011);}
      });
      next.accept();
      next.send(JSON.stringify({action:'attach_session',...(resume?{session_id:sessionId}:{}),memory_scope:'session',delegation:{type:'none'}}));
    }
    armDeadline();
    server.addEventListener('message',async event=>{
      if(state==='closed')return;
      try{
        if(state==='waiting'){
          if(typeof event.data!=='string'||event.data.length>8192)throw new VexaError('请先验证密钥再开始。');
          const auth=JSON.parse(event.data);if(auth.action!=='local.authenticate')throw new VexaError('缺少会话认证。');
          apiKey=credential(auth.apiKey);await openRemote(false);
          return;
        }
        if(state==='reconnecting')return; // Microphone recording continues; do not replay a backlog at accelerated speed.
        if(state!=='ready'||!attached||remote?.readyState!==1)throw new VexaError('会话尚未就绪。');
        if(typeof event.data!=='string'){
          if(event.data.byteLength>4*1024*1024)throw new VexaError('音频片段过大。');
          remote.send(event.data);return;
        }
        if(event.data.length>65536)throw new VexaError('请求过大。');
        const value=validateRequest(JSON.parse(event.data));if(!allowedActions.has(value.action))throw new VexaError('不支持的会话操作。');
        remote.send(JSON.stringify(value));
      }catch{finish(state==='connecting'?'无法建立 MOSS 实时会话，请检查 Key、额度和服务状态。':'实时会话请求未被接受，请重新开始。',1008);}
    });
    server.addEventListener('close',()=>finish());server.addEventListener('error',()=>finish('',1011));
    return upgradeResponse(client);
  }
  // 讯飞星火「超拟人交互」：页面先发 local.authenticate（APPID、APIKey、APISecret 和会话选项），之后只发 16 kHz PCM 二进制帧。
  // 服务端把 PCM 包成讯飞请求帧，把讯飞回复拆成字幕事件（JSON）和 24 kHz PCM 音频（二进制）转给页面。
  async function xfOpen(credentials){
    const controller=new AbortController(),deadline=liveTimers.setTimeout(()=>controller.abort(),20000);
    let response;
    try{response=await fetchImpl(await xfSignedUrl(credentials),{headers:{Upgrade:'websocket'},redirect:'manual',signal:controller.signal});}
    catch{throw new XfError('无法连接讯飞，请检查网络后重试。',502);}
    finally{liveTimers.clearTimeout(deadline);}
    if(response.status!==101||!response.webSocket)throw new XfError(response.status===401||response.status===403?'讯飞拒绝了签名：请核对 APIKey 和 APISecret，并确认电脑时间准确。':`讯飞拒绝连接（HTTP ${response.status}），请检查 APPID、APIKey、APISecret 和超拟人交互服务是否已开通。`,502);
    return response.webSocket;
  }
  async function xfVerifyService(credentials){
    const remote=await xfOpen(credentials),options=xfOptions({uid:'verify-'+crypto.randomUUID(),prompt:'服务授权检测，请保持安静，不主动说话。'});
    remote.binaryType='arraybuffer';
    return new Promise((resolve,reject)=>{
      let done=false,first=true,frames=0,ack=false,interval=null,settle=null;
      const finish=error=>{
        if(done)return;done=true;liveTimers.clearInterval(interval);liveTimers.clearTimeout(settle);
        try{if(remote.readyState===1&&frames)remote.send(JSON.stringify(xfFrame(credentials,options,{status:2})));}catch{}
        try{remote.close(1000,'服务验证结束');}catch{}
        error?reject(error):resolve({ok:true,serviceVerified:true,probeMs:3000});
      };
      const send=()=>{if(done)return;try{remote.send(JSON.stringify(xfFrame(credentials,options,{status:first?0:1,audio:new Uint8Array(640)})));first=false;frames++;}catch{finish(new XfError('讯飞试连时音频发送失败，请重试。',502));}};
      remote.addEventListener('message',event=>{if(done)return;try{const {event:value}=xfParse(event.data);if(value.code)finish(new XfError(xfErrorMessage(value.code,value.message),value.code===11200?403:502));else ack=true;}catch{finish(new XfError('讯飞服务试连返回的数据格式异常。',502));}});
      remote.addEventListener('close',()=>{if(!done)finish(new XfError('讯飞在业务试连期间关闭连接，请检查超拟人交互授权和额度。',502));});
      remote.addEventListener('error',()=>finish(new XfError('讯飞服务试连失败，请检查网络和服务授权。',502)));
      try{remote.accept();send();if(!done){interval=liveTimers.setInterval(send,20);settle=liveTimers.setTimeout(()=>finish(ack?null:new XfError('讯飞没有确认业务请求，请稍后重新验证。',502)),3000);}}catch{finish(new XfError('无法完成讯飞服务试连。',502));}
    });
  }
  function connectXf(request){
    if(request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return json({error:'需要 WebSocket 连接。'},426);
    const [client,server]=Object.values(pairFactory());server.accept();server.binaryType='arraybuffer';
    let remote=null,state='waiting',credentials,options,first=true,openedAt=0;
    const send=value=>{try{if(server.readyState===1)server.send(typeof value==='string'||value instanceof ArrayBuffer?value:JSON.stringify(value));}catch{}};
    const finish=(message='',code=1000)=>{
      if(state==='closed')return;const wasReady=state==='ready';state='closed';clearTimeout(timer);if(message)send({type:'local.error',message});
      try{if(wasReady&&remote?.readyState===1&&!first)remote.send(JSON.stringify(xfFrame(credentials,options,{status:2})));}catch{}
      try{remote?.close(1000,'会话结束');}catch{}try{server.close(code,'会话结束');}catch{}
    };
    const timer=setTimeout(()=>finish('讯飞会话建立超时，请重新开始。',1008),30000);
    server.addEventListener('message',async event=>{
      if(state==='closed')return;
      try{
        if(state==='waiting'){
          if(typeof event.data!=='string'||event.data.length>8192)throw new XfError('请先验证讯飞密钥再开始。');
          const auth=JSON.parse(event.data);if(auth.action!=='local.authenticate')throw new XfError('缺少会话认证。');
          credentials=xfCredentials(auth);options=xfOptions(auth);state='connecting';
          remote=await xfOpen(credentials);remote.binaryType='arraybuffer';
          if(state==='closed'){try{remote.close(1000,'页面连接已结束');}catch{}return;}
          remote.addEventListener('message',incoming=>{
            if(state==='closed')return;
            try{
              const {event:value,audio}=xfParse(incoming.data);
              if(value.code!==0)return finish(xfErrorMessage(value.code,value.message),1011);
              send(value);if(audio?.byteLength)send(audio.buffer.slice(audio.byteOffset,audio.byteOffset+audio.byteLength));
            }catch{finish('讯飞实时语音协议处理失败，请重新开始。',1011);}
          });
          remote.addEventListener('close',event=>finish(state==='ready'?`讯飞在连接 ${Math.max(0,Math.round((Date.now()-openedAt)/1000))} 秒后关闭（代码 ${event.code||'未提供'}）。请检查超拟人交互的授权和额度；录音、字幕已保留。`:''));
          remote.addEventListener('error',()=>finish('讯飞实时连接出现错误，请重试。',1011));
          remote.accept();state='ready';openedAt=Date.now();clearTimeout(timer);send({type:'xf.ready'});
          return;
        }
        if(state!=='ready'||remote?.readyState!==1)throw new XfError('会话尚未就绪。');
        if(typeof event.data==='string'){
          const value=JSON.parse(event.data);
          if(value?.action==='local.end')return finish();
          throw new XfError('不支持的会话操作。');
        }
        if(event.data.byteLength>64000)throw new XfError('音频片段过大。');
        remote.send(JSON.stringify(xfFrame(credentials,options,{status:first?0:1,audio:new Uint8Array(event.data)})));first=false;
      }catch(error){finish(error instanceof XfError?error.message:state==='connecting'?'无法建立讯飞实时会话，请检查密钥和服务状态。':'实时会话请求未被接受，请重新开始。',1008);}
    });
    server.addEventListener('close',()=>finish());server.addEventListener('error',()=>finish('',1011));
    return upgradeResponse(client);
  }
  async function handle(request){
    const url=new URL(request.url),path=url.pathname;
    if(path.startsWith('/api/')||path==='/connect'||path==='/connect-xf'){
      const origin=request.headers.get('Origin');
      if(!origin||!originAllowed(request))return json({error:'请求来源不正确。'},403);
      if(path==='/connect')return request.method==='GET'?connect(request):json({error:'方法不支持。'},405);
      if(path==='/connect-xf')return request.method==='GET'?connectXf(request):json({error:'方法不支持。'},405);
      if(path==='/api/xf/verify'&&request.method==='POST'){
        try{return json(await xfVerifyService(xfCredentials(await readBody(request,8192,XfError))));}
        catch(error){return json({error:error instanceof XfError?error.message:'验证未能完成，请稍后重试。'},error.status||502);}
      }
      if(request.method!=='POST')return json({error:'请通过页面操作。'},405);
      if(['/api/moss/transcribe','/api/moss/task','/api/moss/summary','/api/moss/ask','/api/moss/voices','/api/moss/speech'].includes(path)){
        let key='';try{key=credential(request.headers.get('Authorization')?.match(/^Bearer (.+)$/i)?.[1]);}catch{}
        return recapRoute(path,{key,fetchImpl,signal:request.signal,contentType:request.headers.get('Content-Type'),transcribeModel:request.headers.get('X-Transcribe-Model'),keyterms:request.headers.get('X-Keyterms'),readBytes:limit=>readBytes(request,limit,RecapError),readJson:limit=>readBody(request,limit,RecapError)});
      }
      try{
        const data=await readBody(request);
        if(!data||typeof data!=='object'||Array.isArray(data))throw new VexaError('请求格式不正确。',400);
        if(path==='/api/moss/verify'){await upstream(MOSS,'/v1/models',credential(request.headers.get('Authorization')?.match(/^Bearer (.+)$/i)?.[1]));return json({ok:true});}
        const key=credential(request.headers.get('Authorization')?.match(/^Bearer (.+)$/i)?.[1]);
        if(path==='/api/vexa/verify'){await upstream(VEXA,'/meetings?limit=1',key);return json({ok:true});}
        if(path==='/api/vexa/start'){
          const parsed=parseMeetingUrl(data.meetingUrl),botName=String(data.botName||'Vexa · 会议助手').trim();
          if(!botName||botName.length>60||/[\r\n]/.test(botName))throw new VexaError('机器人名称请使用 1–60 个字符。');
          if(data.language&&!['zh','en'].includes(data.language))throw new VexaError('请选择自动识别、中文或英文。');
          const response=await upstream(VEXA,'/bots',key,{method:'POST',data:{meeting_url:parsed.meetingUrl,bot_name:botName,...(data.language?{language:data.language}:{}),transcribe_enabled:true,recording_enabled:false,automatic_leave:{max_time_left_alone:300000}}});
          return json({meeting:{...parsed,botName,status:response.status||'requested',startedAt:new Date().toISOString(),segments:[],lastSyncAt:null,lastError:''}});
        }
        if(path==='/api/vexa/poll'){
          const {tail}=nativeKey(data);const response=await upstream(VEXA,`/transcripts/${tail}`,key);
          return json({status:typeof response.status==='string'?response.status:null,segments:normalizeSegments(response.segments),lastSyncAt:new Date().toISOString()});
        }
        if(path==='/api/vexa/stop'){const {tail}=nativeKey(data);await upstream(VEXA,`/bots/${tail}`,key,{method:'DELETE'});return json({ok:true});}
        return json({error:'接口不存在。'},404);
      }catch(error){return json({error:error instanceof VexaError?error.message:'请求未能完成，请稍后重试。'},error.status||502);}
    }
    if(request.method!=='GET'&&request.method!=='HEAD')return json({error:'方法不支持。'},405);
    const name=path==='/'||path==='/index.html'?'/index.html':path==='/vexa'?'/vexa.html':path==='/demo'||path==='/demo/'?'/demo/index.html':path;
    const asset=assets[name];if(!asset)return json({error:'页面不存在。'},404);
    const socketOrigins=[url.origin,siteOrigin].filter(Boolean).map(value=>value.replace(/^http/,'ws')).join(' ');
    return new Response(request.method==='HEAD'?null:asset.text,{headers:{'Content-Type':asset.type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':`default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ${socketOrigins}; media-src 'self' blob:; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'`,'Permissions-Policy':'microphone=(self), camera=()'}});
  }
  return {async fetch(request){
    const origin=request.headers.get('Origin'),isApi=new URL(request.url).pathname.startsWith('/api/');
    const cors=isApi&&originAllowed(request)?{'Access-Control-Allow-Origin':origin,'Vary':'Origin','Access-Control-Expose-Headers':'X-Meeting-Model'}:{};
    if(isApi&&request.method==='OPTIONS'){
      const method=request.headers.get('Access-Control-Request-Method');
      const headers=(request.headers.get('Access-Control-Request-Headers')||'').toLowerCase().split(',').map(value=>value.trim()).filter(Boolean);
      if(!originAllowed(request)||method!=='POST'||headers.some(name=>!['authorization','content-type','x-keyterms','x-transcribe-model'].includes(name)))return json({error:'请求来源或方法不正确。'},403);
      return new Response(null,{status:204,headers:{...cors,'Access-Control-Allow-Methods':'POST','Access-Control-Allow-Headers':'Authorization, Content-Type, X-Keyterms, X-Transcribe-Model','Access-Control-Max-Age':'600'}});
    }
    const response=await handle(request);
    if(!isApi||!originAllowed(request))return response;
    const headers=new Headers(response.headers);for(const [name,value] of Object.entries(cors))headers.set(name,value);
    return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
  }};
}
export default createCloudApp({assets:typeof WORKER_ASSETS==='undefined'?{}:WORKER_ASSETS,siteOrigin:typeof SITE_ORIGIN==='undefined'?undefined:SITE_ORIGIN,additionalOrigins:['https://kechangyuan3.github.io']});


