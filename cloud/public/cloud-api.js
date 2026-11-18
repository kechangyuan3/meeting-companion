import {apiUrl} from './service-base.js';
// Each browser document owns these runtime variables. No key enters localStorage or cookies.
let mossKey='',vexaKey='',meeting=null;
const terminal=new Set(['completed','failed','stopped','ended','evicted','cancelled','error']);
const summary={state:'idle',text:'',error:''};
const active=()=>!!meeting&&!terminal.has(meeting.status);
function rememberMeeting(){try{if(active())sessionStorage.setItem('meeting-companion-vexa',JSON.stringify({platform:meeting.platform,nativeMeetingId:meeting.nativeMeetingId,botName:meeting.botName,status:meeting.status,startedAt:meeting.startedAt}));else sessionStorage.removeItem('meeting-companion-vexa');}catch{}}
try{const saved=JSON.parse(sessionStorage.getItem('meeting-companion-vexa')||'null');if(saved?.platform&&saved.nativeMeetingId)meeting={...saved,meetingUrl:'',segments:[],lastError:'请重新填写同一账户的 Vexa Key，以继续同步或让机器人退出。',lastSyncAt:null};}catch{}
function state(){return {configured:!!vexaKey,busy:false,active:active(),meeting,summary};}
async function call(path,key,data={}){
  if(!key)throw Error('请先填写并验证对应服务的完整 API Key。');
  let response;try{response=await fetch(apiUrl(path),{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},body:JSON.stringify(data),signal:AbortSignal.timeout(30000)});}catch{throw Error('连接超时或网络不可达，请稍后重试。');}
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
// 会后整理请求：附上当前页面内存里的 MOSS Key，经本站中转到 MOSS。
export function mossRequest(path,init={}){if(!mossKey)return Promise.reject(Error('MOSS Key 已清除，请重新填写并验证后再生成。'));return fetch(apiUrl(path),{...init,headers:{...(init.headers||{}),Authorization:'Bearer '+mossKey}});}
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
// 讯飞星火「超拟人交互」：APPID、APIKey、APISecret 只保留在当前页面内存，开始会议时随实时连接发给本站签名。
let xfKey=null,xfVerified=false;
export async function xfConfigure(values){
  xfVerified=false;
  const data={appId:String(values.appId||'').trim(),apiKey:String(values.apiKey||'').trim(),apiSecret:String(values.apiSecret||'').trim()};
  if(!data.appId||!data.apiKey||!data.apiSecret)throw Error('请把 APPID、APIKey、APISecret 三项都填上。');
  let response;try{response=await fetch(apiUrl('/api/xf/verify'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(30000)});}catch{throw Error('连接超时或网络不可达，请稍后重试。');}
  let value;try{value=await response.json();}catch{throw Error('在线服务暂未响应，请稍后重试。');}
  if(!response.ok)throw Error(value.error||`验证失败（HTTP ${response.status}）。`);
  if(value.serviceVerified!==true)throw Error('讯飞尚未通过业务授权检测，请刷新页面后重新验证。');
  xfKey=data;xfVerified=true;return {ok:true};
}
export const xfConfigured=()=>!!xfKey&&xfVerified;
export const xfMarkUnverified=()=>{xfVerified=false;};
export const currentXfCredentials=()=>xfKey ? {...xfKey} : null;
export const mossConfigured=()=>!!mossKey;
export function authenticateXf(socket,options){socket.send(JSON.stringify({action:'local.authenticate',...xfKey,...options}));}
export function xfForget(){xfKey=null;xfVerified=false;}
window.addEventListener('pagehide',()=>{mossKey='';vexaKey='';xfKey=null;xfVerified=false;});

