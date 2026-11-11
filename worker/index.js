import {VexaError,parseMeetingUrl,normalizeSegments} from '../vexa-shared.mjs';
import {validateRequest,filterEvent} from '../runtime/public-api.mjs';

const VEXA='https://api.cloud.vexa.ai';
const MOSS='https://api.mosi.cn';
const allowedActions=new Set(['media.mode','mic_state','playback.chunk.completed','playback.completed','playback.stopped','session.update','conversation.item.create','response.create','ping']);
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
function credential(value){const key=String(value||'').trim();if(key.length<8||key.length>4096||/[\r\n]/.test(key))throw new VexaError('请填写完整的 API Key。',400);return key;}
async function readBody(request){
  if(Number(request.headers.get('Content-Length'))>65536)throw new VexaError('请求过大。',413);
  const reader=request.body?.getReader();if(!reader)return {};
  const chunks=[];let size=0;
  try {while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536){await reader.cancel();throw new VexaError('请求过大。',413);}chunks.push(value);}}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  try{return JSON.parse(new TextDecoder().decode(bytes)||'{}');}catch{throw new VexaError('请求格式不正确。',400);}
}
function nativeKey(data){
  const platform=data.platform,id=String(data.nativeMeetingId||'');
  const valid=(platform==='google_meet'&&/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(id))||(platform==='zoom'&&/^\d{9,12}$/.test(id))||(platform==='teams'&&(/^(\d{10,15})$/.test(id)||/^19:meeting_[^/\s]{1,500}@thread\.v2$/.test(id)));
  if(!valid)throw new VexaError('会议标识不正确，请重新粘贴完整会议链接。',400);
  return {platform,id,tail:`${platform}/${encodeURIComponent(id)}`};
}

export function createCloudApp({fetchImpl=fetch,assets={},siteOrigin,pairFactory=()=>new WebSocketPair(),upgradeResponse=client=>new Response(null,{status:101,webSocket:client})}={}){
  async function upstream(base,path,key,{method='GET',data}={}){
    let response;
    try{response=await fetchImpl(`${base}${path}`,{method,headers:{...(base===MOSS?{Authorization:`Bearer ${key}`}:{'X-API-Key':key}),...(data?{'Content-Type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{}),signal:AbortSignal.timeout(25000),redirect:'error'});}
    catch{throw new VexaError(`无法连接 ${base===MOSS?'MOSS':'Vexa'}，请检查网络后重试。`,502);}
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
    let remote=null,state='waiting',attached=false;
    const send=value=>{try{if(server.readyState===1)server.send(JSON.stringify(value));}catch{}};
    const finish=(message='',code=1000)=>{if(state==='closed')return;state='closed';clearTimeout(timer);if(message)send({type:'local.error',message});try{remote?.close(code,'会话结束');}catch{}try{server.close(code,'会话结束');}catch{}};
    const timer=setTimeout(()=>finish('实时会话建立超时，请重新开始。',1008),30000);
    server.addEventListener('message',async event=>{
      if(state==='closed')return;
      try{
        if(state==='waiting'){
          if(typeof event.data!=='string'||event.data.length>8192)throw new VexaError('请先验证密钥再开始。');
          const auth=JSON.parse(event.data);if(auth.action!=='local.authenticate')throw new VexaError('缺少会话认证。');
          const key=credential(auth.apiKey);state='connecting';
          const response=await fetchImpl(`${MOSS}/v1/realtime?model=moss-live-1.0`,{headers:{Upgrade:'websocket',Authorization:`Bearer ${key}`},redirect:'error',signal:AbortSignal.timeout(25000)});
          if(response.status!==101||!response.webSocket)throw new VexaError(`MOSS 拒绝连接（HTTP ${response.status}），请检查 Key、模型权限和额度。`);
          remote=response.webSocket;remote.binaryType='arraybuffer';
          if(state==='closed'){try{remote.close(1000,'页面连接已结束');}catch{}return;}
          remote.addEventListener('message',incoming=>{
            if(state==='closed')return;
            try{
              if(typeof incoming.data!=='string'){if(server.readyState===1)server.send(incoming.data);return;}
              const raw=JSON.parse(incoming.data);
              if(raw.action==='session_attached'){attached=true;clearTimeout(timer);}
              const filtered=filterEvent(raw);if(filtered)send(filtered);
            }catch{finish('实时语音协议处理失败，请重新开始。',1011);}
          });
          remote.addEventListener('close',()=>finish('MOSS 实时连接已结束。'));
          remote.addEventListener('error',()=>finish('MOSS 实时连接出现错误，请重试。',1011));
          remote.accept();state='ready';remote.send(JSON.stringify({action:'attach_session',memory_scope:'session',delegation:{type:'none'}}));
          return;
        }
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
  return {async fetch(request){
    const url=new URL(request.url),path=url.pathname;
    if(path.startsWith('/api/')||path==='/connect'){
      const origin=request.headers.get('Origin');
      if(!origin||![url.origin,siteOrigin].filter(Boolean).includes(origin))return json({error:'请求来源不正确。'},403);
      if(path==='/connect')return request.method==='GET'?connect(request):json({error:'方法不支持。'},405);
      if(request.method!=='POST')return json({error:'请通过页面操作。'},405);
      try{
        const data=await readBody(request);
        if(!data||typeof data!=='object'||Array.isArray(data))throw new VexaError('请求格式不正确。',400);
        if(path==='/api/moss/verify'){await upstream(MOSS,'/v1/models',credential(request.headers.get('X-Service-Key')));return json({ok:true});}
        const key=credential(request.headers.get('X-Service-Key'));
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
    return new Response(request.method==='HEAD'?null:asset.text,{headers:{'Content-Type':asset.type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':`default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ${socketOrigins}; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'`,'Permissions-Policy':'microphone=(self), camera=()'}});
  }};
}
export default createCloudApp({assets:typeof WORKER_ASSETS==='undefined'?{}:WORKER_ASSETS,siteOrigin:typeof SITE_ORIGIN==='undefined'?undefined:SITE_ORIGIN});
