// 讯飞星火「超拟人交互」实时语音（wss://sparkos.xfyun.cn/v1/openapi/chat）。
// 只在在线版服务端使用：签名鉴权、把 16 kHz PCM 包成讯飞请求帧、把讯飞回复拆成字幕事件和音频。
// 采用全双工模式（interact_mode=continuous）：音频持续上传，由讯飞判断何时开口。

export const XF_HOST = 'sparkos.xfyun.cn';
export const XF_PATH = '/v1/openapi/chat';
export const XF_VOICES = ['x5_lingxiaoyue_flow', 'x5_lingfeiyi_flow'];
export const XF_TTS_RATE = 24000;

export class XfError extends Error {
  constructor(message, status = 400) {super(message); this.status = status;}
}

const toBase64 = bytes => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text = '';
  for (let i = 0; i < view.length; i += 0x8000) text += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(text);
};
const fromBase64 = text => {
  const raw = atob(text); const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
};
const decodeText = text => new TextDecoder().decode(fromBase64(text)).slice(0, 20000);

// 页面填写的 APPID、APIKey、APISecret。只做格式检查，真正的校验由讯飞握手完成。
export function xfCredentials(value) {
  const appId = String(value?.appId || '').trim(), apiKey = String(value?.apiKey || '').trim(), apiSecret = String(value?.apiSecret || '').trim();
  if (!/^[A-Za-z0-9]{4,15}$/.test(appId)) throw new XfError('请填写正确的讯飞 APPID（控制台“服务接口认证信息”里的 APPID）。');
  if (!/^[A-Za-z0-9]{8,128}$/.test(apiKey)) throw new XfError('请填写完整的讯飞 APIKey。');
  if (!/^[A-Za-z0-9+/=_-]{8,128}$/.test(apiSecret)) throw new XfError('请填写完整的讯飞 APISecret。');
  return {appId, apiKey, apiSecret};
}

// 会话选项：发音人、会议提示词、用户标识；resume 为 true 时沿用上一段连接的对话历史（30 分钟续连）。
export function xfOptions(value) {
  const voice = XF_VOICES.includes(value?.voice) ? value.voice : XF_VOICES[0];
  const prompt = String(value?.prompt || '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').slice(0, 1500);
  const uid = String(value?.uid || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'meeting';
  return {voice, prompt, uid, resume: value?.resume === true};
}

// 讯飞通用鉴权：HMAC-SHA256(APISecret, "host: …\ndate: …\nGET /v1/openapi/chat HTTP/1.1")。
export async function xfSignedUrl({apiKey, apiSecret}, date = new Date().toUTCString()) {
  const origin = `host: ${XF_HOST}\ndate: ${date}\nGET ${XF_PATH} HTTP/1.1`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(apiSecret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const signature = toBase64(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(origin)));
  const authorization = btoa(`api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`);
  return `https://${XF_HOST}${XF_PATH}?authorization=${encodeURIComponent(authorization)}&date=${encodeURIComponent(date)}&host=${XF_HOST}`;
}

// 请求帧。status：0 首帧（带全部参数）、1 中间帧、2 最后一帧。全双工模式下 stmid 固定。
export function xfFrame(credentials, options, {status, audio = new Uint8Array(0), stmid = '1'}) {
  const header = {app_id: credentials.appId, uid: options.uid, status, stmid: String(stmid), scene: 'sos_app', interact_mode: 'continuous'};
  const payload = {audio: {audio: toBase64(audio), status, encoding: 'raw', sample_rate: 16000, channels: 1, bit_depth: 16, frame_size: 0}};
  if (status !== 0) return {header, payload};
  return {
    header,
    parameter: {
      iat: {iat: {encoding: 'utf8', compress: 'raw', format: 'json'}},
      nlp: {nlp: {encoding: 'utf8', compress: 'raw', format: 'json'}, new_session: options.resume ? 'false' : 'true', ...(options.prompt ? {prompt: options.prompt} : {})},
      tts: {vcn: options.voice, speed: 50, volume: 50, pitch: 50, tts: {encoding: 'raw', sample_rate: XF_TTS_RATE, channels: 1, bit_depth: 16, frame_size: 0}},
    },
    payload,
  };
}

// 讯飞回复 → 给页面的事件（字幕、对话状态）+ 可选的 PCM 音频。
export function xfParse(text) {
  if (text instanceof ArrayBuffer || ArrayBuffer.isView(text)) text = new TextDecoder().decode(text);
  if (typeof text !== 'string' || text.length > 8 * 1024 * 1024) throw new XfError('讯飞返回的数据格式异常。', 502);
  const raw = JSON.parse(text); const header = raw.header || {}, payload = raw.payload || {};
  const event = {type: 'xf', code: Number(header.code) || 0, message: String(header.message || '').slice(0, 300), status: Number(header.status) || 0};
  if (payload.event?.text) event.event = decodeText(payload.event.text);
  // 最后一帧常常只有 status=2、文字为空，也要转给页面，字幕才能标记为说完。
  if (payload.iat && (payload.iat.text || payload.iat.status != null)) {event.iat = payload.iat.text ? decodeText(payload.iat.text) : ''; event.iatStatus = Number(payload.iat.status) || 0;}
  if (payload.nlp && (payload.nlp.text || payload.nlp.status != null)) {event.nlp = payload.nlp.text ? decodeText(payload.nlp.text) : ''; event.nlpStatus = Number(payload.nlp.status) || 0;}
  let audio = null;
  if (payload.tts?.audio) {
    audio = fromBase64(payload.tts.audio);
    event.tts = {status: Number(payload.tts.status) || 0, seq: Number(payload.tts.seq) || 0, rate: Number(payload.tts.sample_rate) || XF_TTS_RATE};
  }
  return {event, audio};
}

export function xfErrorMessage(code, message = '') {
  if (code === 11200) return '讯飞服务授权/额度未通过（11200）：当前 APPID 没有“超拟人交互”授权，或授权包/额度已失效。请检查该服务的授权包和有效期；OCR 额度不能用于实时语音。';
  if (code === 10110 || /licen[cs]e/i.test(message)) return '讯飞授权未通过：请确认这个 APPID 已在讯飞控制台领取或购买“超拟人交互”服务包。';
  if (code === 10313 || /app_?id/i.test(message)) return '讯飞 APPID 与 APIKey 不匹配，请从同一个应用复制。';
  if (/time|超时|expire/i.test(message)) return `讯飞会话超时（${code}），请重新开始。`;
  return `讯飞返回错误 ${code}${message ? `：${message}` : ''}。`;
}
