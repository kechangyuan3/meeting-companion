// Shared progress validation. The default byte budget supports existing services.
export const MAX_PROGRESS_BYTES=600;
export const MAX_CONTENT_CHARACTERS=2000;
export function progressText(text,maxBytes=MAX_PROGRESS_BYTES) {
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1)throw new Error('INVALID_PROGRESS_LIMIT');
 if(typeof text!=='string')return null;
 const value=text.replace(/\s+/g,' ').trim();
 if(!value || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value) || Array.from(value).length>MAX_CONTENT_CHARACTERS || Buffer.byteLength(value,'utf8')>maxBytes)return null;
 return value;
}
export function createProgressSink(report,active=()=>true,maxBytes=MAX_PROGRESS_BYTES) {
 const seen=new Set();
 return (text,options={})=>{
  if(!active())return false;
  const value=progressText(text,maxBytes);
  if(value===null)throw Object.assign(new Error('INVALID_PUBLIC_PROGRESS'),{code:'INVALID_PUBLIC_PROGRESS'});
  if(seen.has(value))return false;
  const accepted=report(value,options);
  if(accepted!==false)seen.add(value);
  return accepted!==false;
 };
}
