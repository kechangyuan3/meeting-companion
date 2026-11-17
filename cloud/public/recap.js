// 会后整理：录音 → MOSS-Transcribe-Diarize-Pro 分人转写 → Nex N2.6 纪要。
// request(path, init) 由页面提供：本机版直接 fetch，在线版附上当前页面的 Key。

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clock = seconds => {
  if (!Number.isFinite(seconds)) return '--:--';
  const total = Math.max(0, Math.floor(seconds)); const h = Math.floor(total / 3600), m = Math.floor(total % 3600 / 60), s = total % 60;
  return `${h ? `${h}:` : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};
const extension = type => ({'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/flac': 'flac', 'audio/aac': 'aac'})[String(type).split(';')[0]] || 'webm';
const download = (blob, name) => {const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);};

export function createRecap({request, $}) {
  let parts = [], meta = {}, segments = [], summary = '', running = 0, finishedAt = null, transcribed = false, working = false;
  const selectedModel = () => $('transcribe-model')?.value || 'moss-transcribe-diarize-pro';
  let activeModel = selectedModel();
  const card = $('recap');

  function state(kind, text) {
    $('recap-status').textContent = ({idle: '待生成', running: '整理中', done: '已完成', error: '未完成'})[kind];
    $('recap-status').className = `badge ${kind === 'done' ? 'ready' : ''}`;
    $('recap-note').textContent = text; $('recap-note').className = `feedback ${kind === 'error' ? 'error' : kind === 'done' ? 'ok' : ''}`;
    $('recap-run').disabled = kind === 'running' || !parts.length;
    $('recap-run').textContent = kind === 'idle' ? '生成转写和纪要' : transcribed ? '重新生成纪要' : '重新生成';
    $('recap-export').disabled = kind === 'running' || (!segments.length && !summary);
    $('recap-audio').disabled = !parts.length;
  }

  function renderSegments() {
    const box = $('recap-transcript'); box.replaceChildren();
    for (const item of segments) {
      const row = document.createElement('div'); row.className = 'recap-line';
      const time = document.createElement('time'); time.textContent = clock(item.start);
      const who = document.createElement('span'); who.className = 'recap-speaker'; who.textContent = item.speaker;
      const text = document.createElement('span'); text.textContent = item.text;
      row.append(time, who, text); box.append(row);
    }
    $('recap-transcript-card').hidden = !segments.length;
    $('recap-count').textContent = segments.length ? `${segments.length} 段 · ${activeModel === 'moss-transcribe-1.0' ? '普通转写，不区分说话人' : '自动说话人标签'}` : '';
  }

  async function call(path, init) {
    const response = await request(path, init);
    if (!response.ok) {let message = `请求失败（HTTP ${response.status}）。`; try {message = (await response.json()).error || message;} catch {} throw Error(message);}
    return response;
  }

  async function transcribe(part, index, current) {
    const label = parts.length > 1 ? `第 ${index + 1}/${parts.length} 段录音` : '录音';
    state('running', `正在上传${label}（${(part.blob.size / 1048576).toFixed(1)} MB）…`);
    const created = await (await call('/api/moss/transcribe', {method: 'POST', headers: {'Content-Type': part.blob.type, 'X-Transcribe-Model': activeModel, 'X-Keyterms': encodeURIComponent(JSON.stringify(meta.keyterms || []))}, body: part.blob})).json();
    const started = Date.now();
    for (;;) {
      if (current !== running) throw Error('已取消');
      await sleep(Math.max(3, Math.min(15, created.retryAfter || 3)) * 1000);
      const task = await (await call('/api/moss/task', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({taskId: created.taskId})})).json();
      if (task.status === 'SUCCESS') {
        const lines = task.segments.length ? task.segments : task.text?.trim() ? [{speaker: '未分人', start: 0, end: null, text: task.text.trim()}] : [];
        return lines.map(item => ({...item, speaker: parts.length > 1 ? `第${index + 1}段·${item.speaker}` : item.speaker, start: Number.isFinite(item.start) ? item.start + (part.offset || 0) : null}));
      }
      if (task.status === 'FAILED') throw Error(task.error || 'MOSS 转写任务失败。');
      if (Date.now() - started > 45 * 60000) throw Error('转写等待超时，可以稍后点击“重新生成”。');
      state('running', `MOSS 正在转写${label}（${task.status === 'PENDING' ? '排队中' : '处理中'}，已等待 ${Math.round((Date.now() - started) / 1000)} 秒）…`);
    }
  }

  async function summarize(current) {
    state('running', '转写完成，Nex N2.6 正在写纪要…');
    const response = await call('/api/moss/summary', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({segments, conversation: meta.conversation || [], assistantName: meta.nickname})});
    const reader = response.body.getReader(); const decoder = new TextDecoder(); summary = '';
    $('recap-summary').hidden = false;
    for (;;) {
      const {done, value} = await reader.read(); if (done) break;
      if (current !== running) {reader.cancel().catch(() => {}); throw Error('已取消');}
      summary += decoder.decode(value, {stream: true}); $('recap-summary').textContent = summary;
    }
    summary += decoder.decode(); $('recap-summary').textContent = summary;
  }

  async function run() {
    if (!parts.length || working) return;
    working = true;
    if (selectedModel() !== activeModel) {activeModel = selectedModel(); transcribed = false;}
    const current = ++running; summary = ''; $('recap-summary').textContent = ''; $('recap-summary').hidden = true;
    try {
      // 转写已完成时只重新生成纪要，不重复计费。
      if (!transcribed) {
        segments = []; renderSegments();
        for (let index = 0; index < parts.length; index++) {
          segments.push(...await transcribe(parts[index], index, current)); renderSegments();
        }
        transcribed = true;
      }
      if (!segments.length && !(meta.conversation || []).length) throw Error('录音里没有识别到说话内容。');
      await summarize(current);
      finishedAt = new Date(); state('done', '会后整理完成，可以导出纪要。');
    } catch (error) {
      if (current === running) state('error', `${error.message}${segments.length ? ' 已识别的转写保留在下方。' : ''}`);
    } finally {if (current === running) working = false;}
  }

  $('recap-run').onclick = () => void run();
  $('recap-audio').onclick = () => parts.forEach((part, index) => download(part.blob, `MOSS会议录音-${(finishedAt || new Date()).toISOString().slice(0, 10)}${parts.length > 1 ? `-${index + 1}` : ''}.${extension(part.blob.type)}`));
  $('recap-export').onclick = () => {
    const lines = [`# MOSS 会议纪要`, '', `日期：${(meta.endedAt || new Date()).toLocaleString('zh-CN', {hour12: false})}`, '', summary || '（尚未生成纪要）', '', `## 音频转写（${activeModel}）`, ''];
    for (const item of segments) lines.push(`- [${clock(item.start)}] **${item.speaker}**：${item.text}`);
    if ((meta.conversation || []).length) {lines.push('', `## 会中与${meta.nickname}的对话（${meta.engine || 'MOSS-Live'} 字幕）`, ''); for (const item of meta.conversation) lines.push(`- **${item.who === 'ai' ? meta.nickname : '参会者'}**：${item.text}`);}
    download(new Blob([lines.join('\n')], {type: 'text/markdown;charset=utf-8'}), `MOSS会议纪要-${new Date().toISOString().slice(0, 10)}.md`);
  };

  return {
    // 新会议开始：清掉上一场的会后整理。
    reset() {running++; working = false; parts = []; segments = []; summary = ''; meta = {}; transcribed = false; card.hidden = true;},
    summary: () => summary,
    context: () => segments.map(item => ({who: 'user', text: `${item.speaker}：${item.text}`})),
    importAudio(file) {
      if (working) throw Error('请等当前转写或纪要完成后再载入录音。');
      const formats = {webm: 'audio/webm', ogg: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac', aac: 'audio/aac'};
      const type = formats[file?.name?.split('.').at(-1).toLowerCase()];
      if (!type) throw Error('请选择 WebM、OGG、M4A、WAV、MP3、FLAC 或 AAC 文件。');
      if (!file.size || file.size > 40 * 1024 * 1024) throw Error('本页支持大于 0、最多 40 MB 的录音。');
      this.ready([{blob: file.slice(0, file.size, type), offset: 0}], {nickname: '小莫', conversation: [], startedAt: Date.now()}, {auto: false});
      state('idle', `录音已载入（${(file.size / 1048576).toFixed(1)} MB），尚未上传。点击“生成转写和纪要”发送给 MOSS，转写按时长计费；多人模型单段最长 60 分钟。`);
    },
    // 会议结束：拿到录音。auto 为 true 时直接开始整理。
    ready(recorded, info, {auto = true} = {}) {
      running++; working = false; parts = recorded; meta = {...info, endedAt: new Date()}; segments = []; summary = ''; finishedAt = null; transcribed = false; activeModel = selectedModel();
      card.hidden = false; renderSegments(); $('recap-summary').hidden = true;
      if (!parts.length) return state('error', '这场会议没有录到可用的音频。');
      const seconds = Math.max(0, Math.floor((Date.now() - info.startedAt) / 1000));
      const duration = seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
      state('idle', `已录音 ${duration}。生成分人转写按音频时长计费，以 MOSS 控制台当前价格为准；纪要由 Nex N2.6 生成。`);
      if (auto) void run();
    },
  };
}
