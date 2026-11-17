// 会后整理：MOSS-Transcribe-Diarize-Pro 分人转写 + Nex N2.6 纪要。
// 本文件不依赖 Node 专属 API，本机服务和在线 Worker 共用（在线构建时会去掉 export 内联）。

export const RECAP_TRANSCRIBE_MODEL = 'moss-transcribe-diarize-pro';
export const RECAP_SUMMARY_MODEL = 'nex-n2.6';
export const RECAP_MAX_AUDIO_BYTES = 40 * 1024 * 1024;
export const RECAP_MAX_SUMMARY_BODY = 2 * 1024 * 1024;
export const RECAP_AUDIO_TYPES = {'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/wav': 'wav'};
const RECAP_INPUT_LIMIT = 100000;

export class RecapError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'RecapError'; this.status = status; }
}

export function recapAudioType(value) {
  const type = String(value || '').split(';')[0].trim().toLowerCase();
  if (!Object.hasOwn(RECAP_AUDIO_TYPES, type)) throw new RecapError('录音格式不受支持，请使用 Chrome、Edge 或 Safari 重新开会。', 415);
  return type;
}

export function recapTaskId(value) {
  const id = String(value || '');
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) throw new RecapError('转写任务编号不正确。');
  return id;
}

export function recapKeyterms(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(term => typeof term === 'string').map(term => term.trim()).filter(term => term && Array.from(term).length <= 30))].slice(0, 20);
}

// 异步转写：返回任务编号，再用 /v1/audio/tasks/{id} 查询结果。
export function recapTranscribeForm(bytes, type, keyterms = []) {
  const form = new FormData();
  form.append('model', RECAP_TRANSCRIBE_MODEL);
  form.append('diarize', 'true');
  form.append('async', 'true');
  const terms = recapKeyterms(keyterms);
  if (terms.length) form.append('keyterms', JSON.stringify(terms));
  form.append('file', new Blob([bytes], {type}), `meeting.${RECAP_AUDIO_TYPES[type]}`);
  return form;
}

export function recapTaskCreated(value) {
  const id = value?.task_id || value?.id;
  if (typeof id !== 'string' || !id) throw new RecapError('MOSS 没有返回转写任务编号，请稍后重试。', 502);
  return {taskId: recapTaskId(id), status: String(value.status || 'PENDING'), retryAfter: Number.isFinite(value.retry_after) ? value.retry_after : null};
}

export function recapTask(value) {
  const status = String(value?.status || '').toUpperCase();
  const segments = (Array.isArray(value?.segments) ? value.segments : []).filter(item => item && typeof item.text === 'string' && item.text.trim()).map(item => ({
    speaker: typeof item.speaker === 'string' && item.speaker ? item.speaker.slice(0, 40) : '未知',
    start: Number.isFinite(item.start) ? item.start : null,
    end: Number.isFinite(item.end) ? item.end : null,
    text: item.text.trim(),
  }));
  const error = status === 'FAILED' ? (typeof value?.error?.message === 'string' && value.error.message ? value.error.message.slice(0, 300) : '转写任务失败。') : '';
  return {status: status || 'PENDING', text: typeof value?.text === 'string' ? value.text : '', segments, error};
}

const clock = seconds => {
  if (!Number.isFinite(seconds)) return '--:--';
  const total = Math.max(0, Math.floor(seconds)); const h = Math.floor(total / 3600), m = Math.floor(total % 3600 / 60), s = total % 60;
  return `${h ? `${h}:` : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};
export const recapClock = clock;

function recapInput(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new RecapError('请求格式不正确。');
  const segments = (Array.isArray(data.segments) ? data.segments : []).filter(item => item && typeof item.text === 'string' && item.text.trim()).slice(0, 20000);
  const conversation = (Array.isArray(data.conversation) ? data.conversation : []).filter(item => item && typeof item.text === 'string' && item.text.trim()).slice(0, 2000);
  if (!segments.length && !conversation.length) throw new RecapError('没有可以总结的会议内容。');
  const name = typeof data.assistantName === 'string' && data.assistantName.trim() ? data.assistantName.trim().slice(0, 20) : '小莫';
  return {segments, conversation, name};
}

// Nex N2.6 的 Chat Completions 请求体。只依据转写写纪要，不编造。
export function recapSummaryRequest(data) {
  const {segments, conversation, name} = recapInput(data);
  let transcript = segments.map(item => `[${clock(item.start)}] ${String(item.speaker || '未知').slice(0, 40)}：${item.text.trim()}`).join('\n');
  let dialogue = conversation.map(item => `${item.who === 'ai' ? name : '参会者'}：${item.text.trim()}`).join('\n');
  let truncated = false;
  if (transcript.length + dialogue.length > RECAP_INPUT_LIMIT) {
    truncated = true;
    dialogue = dialogue.slice(0, Math.min(dialogue.length, 20000));
    transcript = transcript.slice(0, RECAP_INPUT_LIMIT - dialogue.length);
  }
  const system = [
    '你是会议纪要助手。只根据用户提供的会议转写写纪要，不补充转写里没有的信息，不编造人名、负责人、日期或数字。',
    '转写里的说话人标签（如 S01、S02）是自动识别的，不代表真实姓名。只有转写中明确出现姓名时才可以对应，否则保留标签。',
    `“${name}”是会议中的 AI 参会者，它的发言只作参考，决定以人的发言为准。`,
    '用简体中文输出 Markdown，按以下结构，没有内容的部分写“无”：',
    '## 会议概要（2–3 句）\n## 决定\n## 待办（每条写：事项｜负责人｜截止时间；转写里没有就写“待确认”）\n## 分歧与未决问题\n## 需要会后确认的信息',
  ].join('\n');
  const parts = [];
  if (transcript) parts.push(`# 会议分人转写（MOSS-Transcribe-Diarize-Pro）\n${transcript}`);
  if (dialogue) parts.push(`# 会中与 ${name} 的实时对话字幕（MOSS-Live，仅作参考）\n${dialogue}`);
  if (truncated) parts.push('（注意：会议内容过长，以上已截断，请在概要中说明纪要只覆盖前半部分。）');
  return {
    model: RECAP_SUMMARY_MODEL, stream: true, max_tokens: 16384,
    messages: [{role: 'system', content: system}, {role: 'user', content: parts.join('\n\n')}],
  };
}

// 读取 Chat Completions 的 SSE，只产出最终正文（跳过思考过程）。
export async function* recapSummaryText(body) {
  const reader = body.getReader(); const decoder = new TextDecoder(); let buffer = '', done = false, finished = false;
  try {
    while (!done) {
      const chunk = await reader.read(); done = chunk.done;
      buffer += decoder.decode(chunk.value || new Uint8Array(), {stream: !done});
      const lines = buffer.split(/\r?\n/); buffer = done ? '' : lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === '[DONE]') {finished = true; continue;}
        let event; try {event = JSON.parse(payload);} catch {continue;}
        if (event?.error) throw new RecapError(`总结生成失败：${String(event.error.message || event.error.code || '未知错误').slice(0, 200)}`, 502);
        for (const choice of Array.isArray(event?.choices) ? event.choices : []) {
          const text = choice?.delta?.content;
          if (typeof text === 'string' && text) yield text;
        }
      }
    }
  } finally { reader.releaseLock(); }
  if (!finished) throw new RecapError('总结在生成途中中断，内容可能不完整。', 502);
}

// 把总结正文包成给浏览器的纯文本流；出错时在末尾追加说明。
export function recapSummaryStream(body) {
  const encoder = new TextEncoder();
  return new ReadableStream({async start(controller) {
    try { for await (const text of recapSummaryText(body)) controller.enqueue(encoder.encode(text)); }
    catch (error) { controller.enqueue(encoder.encode(`\n\n> 注意：${error instanceof RecapError ? error.message : '总结在生成途中中断，内容可能不完整。'}`)); }
    controller.close();
  }});
}

const recapJson = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}});

// 三个会后整理接口，本机服务和在线 Worker 共用。返回标准 Response。
// io: {key, fetchImpl, contentType, readBytes(limit) → Uint8Array, readJson(limit) → object}
export async function recapRoute(path, io) {
  const MOSS = 'https://api.mosi.cn';
  const call = async (url, init, timeout) => {
    let response;
    try { response = await io.fetchImpl(`${MOSS}${url}`, {...init, headers: {Authorization: `Bearer ${io.key}`, ...(init.headers || {})}, redirect: 'manual', signal: AbortSignal.timeout(timeout)}); }
    catch (error) { throw new RecapError(error?.name === 'TimeoutError' ? '连接 MOSS 超时，请稍后重试。' : '无法连接 MOSS，请检查网络后重试。', 502); }
    if (response.status >= 300 && response.status < 400) throw new RecapError('MOSS 返回了非预期跳转，已停止请求。', 502);
    if (!response.ok) throw recapUpstreamError(response.status);
    return response;
  };
  const parse = async response => { try { return await response.json(); } catch { throw new RecapError('MOSS 返回的数据格式异常。', 502); } };
  try {
    if (!io.key) throw new RecapError('请先填写并验证 MOSS API Key。', 401);
    if (path === '/api/moss/transcribe') {
      const type = recapAudioType(io.contentType);
      const bytes = await io.readBytes(RECAP_MAX_AUDIO_BYTES);
      if (!bytes?.byteLength) throw new RecapError('录音为空，无法转写。');
      const keyterms = (() => { try { return JSON.parse(decodeURIComponent(io.keyterms || '[]')); } catch { return []; } })();
      const response = await call('/v1/audio/transcriptions', {method: 'POST', body: recapTranscribeForm(bytes, type, keyterms)}, 120000);
      return recapJson(recapTaskCreated(await parse(response)));
    }
    if (path === '/api/moss/task') {
      const data = await io.readJson(4096);
      const response = await call(`/v1/audio/tasks/${encodeURIComponent(recapTaskId(data?.taskId))}`, {method: 'GET'}, 25000);
      return recapJson(recapTask(await parse(response)));
    }
    if (path === '/api/moss/summary') {
      const request = recapSummaryRequest(await io.readJson(RECAP_MAX_SUMMARY_BODY));
      const response = await call('/v1/chat/completions', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(request)}, 600000);
      if (!response.body) throw new RecapError('MOSS 没有返回总结内容。', 502);
      return new Response(recapSummaryStream(response.body), {headers: {'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}});
    }
    return recapJson({error: '接口不存在。'}, 404);
  } catch (error) {
    return recapJson({error: error instanceof RecapError ? error.message : '会后整理请求未能完成，请稍后重试。'}, error instanceof RecapError ? error.status : 502);
  }
}

export function recapUpstreamError(status) {
  const messages = {400: 'MOSS 不接受这次请求，请检查录音是否为空或过长（单段最长 60 分钟）。', 401: 'MOSS Key 无效，请重新验证。', 402: 'MOSS 账户额度不足。', 403: 'MOSS 拒绝访问，请检查 Key 权限和额度。', 404: '转写任务不存在或已过期。', 413: '录音文件过大。', 429: '请求太频繁或同时进行的转写任务过多，请稍后重试。'};
  return new RecapError(messages[status] || `MOSS 请求失败（HTTP ${status}）。`, status >= 500 ? 502 : status);
}
