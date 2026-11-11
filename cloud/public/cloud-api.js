// Each browser document owns these variables. No key enters localStorage or cookies.
let mossKey='',vexaKey='',meeting=null;
const terminal=new Set(['completed','failed','stopped','ended','evicted','cancelled','error']);
const summary={state:'idle',text:'',error:''};
const active=()=>!!meeting&&!terminal.has(meeting.status);
function rememberMeeting(){try{if(active())sessionStorage.setItem('meeting-companion-vexa',JSON.stringify({platform:meeting.platform,nativeMeetingId:meeting.nativeMeetingId,botName:meeting.botName,status:meeting.status,startedAt:meeting.startedAt}));else sessionStorage.removeItem('meeting-companion-vexa');}catch{}}
try{const saved=JSON.parse(sessionStorage.getItem('meeting-companion-vexa')||'null');if(saved?.platform&&saved.nativeMeetingId)meeting={...saved,meetingUrl:'',segments:[],lastError:'请重新填写同一账户的 Vexa Key，以继续同步或让机器人退出。',lastSyncAt:null};}catch{}
function state(){return {configured:!!vexaKey,busy:false,active:active(),meeting,summary};}
async function call(path,key,data={}){
  if(!key)throw Error('请先填写并验证对应服务的完整 API Key。');
  let response;try{response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Service-Key':key},body:JSON.stringify(data),signal:AbortSignal.timeout(30000)});}catch{throw Error('连接超时或网络不可达，请稍后重试。');}
  let value;try{value=await response.json();}catch{throw Error('在线服务暂未响应，请稍后重试。');}
  if(!response.ok){const error=Error(value.error||`请求失败（HTTP ${response.status}）。`);error.status=response.status;throw error;}return value;
}
export async function mossApi(path,data){
  if(path==='/api/status')return {configured:!!mossKey,verified:!!mossKey,backend:'在线语音',backendAvailable:false,backendTest:null};
  if(path==='/api/configure'){const key=String(data.apiKey||'').trim();await call('/api/moss/verify',key);mossKey=key;return {ok:true};}
  if(path==='/api/stop')return {ok:true};
  if(path==='/api/shutdown'||path==='/api/forget-key'){mossKey='';return {ok:true};}
  throw Error('在线版提供实时语音；Codex 后台任务请使用本机版本。');
}
export function authenticateMoss(socket){socket.send(JSON.stringify({action:'local.authenticate',apiKey:mossKey}));}
export async function vexaApi(path,data){
  const action=path.replace('/api/vexa/','');
  if(action==='status')return state();
  if(action==='configure'){const key=String(data.apiKey||'').trim();await call('/api/vexa/verify',key);vexaKey=key;if(meeting)meeting.lastError='';return state();}
  if(action==='forget'){if(active())throw Error('请先让机器人退出会议。');vexaKey='';return state();}
  if(action==='start'){
    if(active())throw Error('请先让当前机器人退出会议。');
    const result=await call('/api/vexa/start',vexaKey,data);meeting=result.meeting;rememberMeeting();return state();
  }
  if(action==='poll'){
    if(!meeting)return state();
    try{const result=await call('/api/vexa/poll',vexaKey,{platform:meeting.platform,nativeMeetingId:meeting.nativeMeetingId});meeting.segments=result.segments;meeting.status=result.status||meeting.status;meeting.lastSyncAt=result.lastSyncAt;meeting.lastError='';rememberMeeting();}
    catch(error){meeting.lastError=error.message;if(error.status!==404||Date.now()-Date.parse(meeting.startedAt)>120000)throw error;}
    return state();
  }
  if(action==='stop'){
    if(!meeting)return state();
    await call('/api/vexa/stop',vexaKey,{platform:meeting.platform,nativeMeetingId:meeting.nativeMeetingId});meeting.status='stopping';meeting.lastError='';rememberMeeting();return state();
  }
  throw Error('在线版可导出转写；使用本机版本可调用 Codex 整理纪要。');
}
window.addEventListener('pagehide',()=>{mossKey='';vexaKey='';});
