import {vexaApi} from './cloud-api.js';
const $ = id => document.getElementById(id);
let state = {configured: false, active: false, meeting: null, summary: {state: 'idle'}}, pending = false, refreshing = false;
const labels = {requested: '已提交入会', joining: '正在加入会议', waiting: '等待主持人允许', waiting_for_admission: '等待主持人允许', lobby: '等候室中', active: '正在记录会议', recording: '正在记录会议', running: '正在记录会议', stopping: '正在退出', stopped: '机器人已退出', completed: '会议已完成', failed: '入会或转写失败', error: '会议出现错误', evicted: '机器人已被移出', cancelled: '会议已取消'};
function feedback(id, text, error = false) {$(id).textContent = text; $(id).className = `feedback ${error ? 'error' : 'ok'}`;}
const api = (path,data) => vexaApi(`/api/vexa/${path}`,data);
function clock(seconds) {if (seconds == null) return '—'; const value = Math.max(0, Math.floor(seconds)); return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;}
let transcriptSignature = '';
function render(next) {
  state = next;
  const m = state.meeting, rows = m?.segments || [], busy = pending || state.busy || refreshing;
  $('vexa-key-badge').textContent = state.configured ? '已验证' : '待填写'; $('vexa-key-badge').className = `badge ${state.configured ? 'ready' : ''}`;
  $('vexa-save').disabled = busy || (state.active && state.configured); $('vexa-key').disabled = busy || (state.active && state.configured);
  $('vexa-forget').disabled = !state.configured || busy || state.active;
  $('vexa-start').disabled = !state.configured || busy || state.active;
  for (const id of ['meeting-url', 'bot-name', 'vexa-language']) $(id).disabled = busy || state.active;
  $('vexa-refresh').disabled = !m || busy || refreshing; $('vexa-stop').disabled = !state.configured || !state.active || busy || m?.status === 'stopping';
  $('vexa-summarize').disabled = true;
  $('vexa-export').disabled = !rows.length && !state.summary.text;
  $('vexa-status').textContent = m ? (labels[m.status] || `会议状态：${m.status}`) : state.configured ? 'Vexa 连接就绪' : '准备连接';
  $('vexa-live-dot').className = `live-dot ${state.active ? 'active' : ''}`;
  $('vexa-title').textContent = m ? `${({zoom: 'Zoom', google_meet: 'Google Meet', teams: 'Teams'})[m.platform] || m.platform} · ${m.botName}` : '给线上会议配一个记录员';
  $('vexa-description').textContent = m ? (state.active ? 'Vexa 正在处理入会或转写。若在等候室，请由主持人允许入会。' : '机器人已结束本次参会。你仍可刷新最后的转写、整理纪要并导出。') : '连接云服务后，真实的会议转写会显示在下方。';
  $('vexa-sync').textContent = m?.lastSyncAt ? `最近同步 ${new Date(m.lastSyncAt).toLocaleTimeString('zh-CN')} · ${state.active ? '每 4 秒自动刷新' : '可手动刷新最后内容'}` : '约每 4 秒刷新；出现文字的速度取决于 Vexa 转写。';
  $('vexa-notice').hidden = !m?.lastError; $('vexa-notice').textContent = m?.lastError || '';
  $('vexa-count').textContent = `${rows.length} 段${rows.some(row => !row.completed) ? ' · 含实时草稿' : ''}`;
  const signature = JSON.stringify(rows);
  if (signature !== transcriptSignature) {
    transcriptSignature = signature; const container = $('vexa-transcript'); const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 70;
    if (rows.length) {
      const fragment = document.createDocumentFragment();
      for (const row of rows) {
        const block = document.createElement('article'); block.className = 'segment';
        const meta = document.createElement('div'); meta.className = 'segment-meta';
        const speaker = document.createElement('strong'); speaker.textContent = row.speaker;
        const time = document.createElement('span'); time.className = 'segment-time'; time.textContent = clock(row.start); meta.append(speaker, time);
        if (!row.completed) {const draft = document.createElement('span'); draft.className = 'segment-draft'; draft.textContent = '识别中'; meta.append(draft);}
        const text = document.createElement('p'); text.textContent = row.text; block.append(meta, text); fragment.append(block);
      }
      container.replaceChildren(fragment);
    } else {const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = '等待第一段真实的会议发言。'; container.replaceChildren(empty);}
    if (atBottom) container.scrollTop = container.scrollHeight;
  }
  const summary = state.summary;
  $('vexa-summary').textContent = summary.text || (summary.state === 'running' ? 'Codex 正在整理，请稍等…' : '在线版可导出原始转写。本机版本可使用已登录的 Codex 整理纪要。');
  feedback('vexa-summary-message', summary.state === 'running' ? '正在整理点击时的已确认转写，会议可以继续。' : summary.state === 'completed' ? `已根据当时的 ${summary.sourceSegments} 段发言整理；后续新增内容需再次整理。${summary.partial ? '长会议仅覆盖最近 60000 个字符。' : ''}` : summary.error || '', summary.state === 'failed');
}
async function action(work, messageId) {
  pending = true; render(state);
  try {render(await work()); return true;}
  catch (error) {feedback(messageId, error.message, true); return false;}
  finally {pending = false; render(state);}
}
$('vexa-save').onclick = async () => {
  feedback('vexa-key-message', '正在验证 Vexa Key…');
  if (await action(() => api('configure', {apiKey: $('vexa-key').value}), 'vexa-key-message')) {$('vexa-key').value = ''; $('vexa-key').placeholder = 'Key 已配置；替换时重新粘贴'; feedback('vexa-key-message', 'Vexa 已验证，可以填写会议链接。');}
};
$('vexa-forget').onclick = async () => {if (await action(() => api('forget', {}), 'vexa-key-message')) {$('vexa-key').value = ''; feedback('vexa-key-message', '已清除当前页面的 Vexa Key。');}};
$('vexa-start').onclick = async () => {
  feedback('vexa-action-message', '正在向 Vexa 提交入会请求…');
  if (await action(() => api('start', {meetingUrl: $('meeting-url').value, botName: $('bot-name').value, language: $('vexa-language').value}), 'vexa-action-message')) {feedback('vexa-action-message', '入会请求已接受，请查看会议等候室。'); await poll();}
};
$('vexa-stop').onclick = async () => {feedback('vexa-action-message', '正在请求机器人退出…'); if (await action(() => api('stop', {}), 'vexa-action-message')) {feedback('vexa-action-message', '退出请求已成功提交，可在会议中确认机器人已离开。'); await poll();}};
async function poll() {
  if (refreshing || pending) return;
  refreshing = true; render(state);
  try {render(await api('poll', {})); feedback('vexa-action-message', state.active ? '转写持续同步中。' : '转写已同步。');}
  catch (error) {feedback('vexa-action-message', error.message, true);}
  finally {refreshing = false; render(state);}
}
$('vexa-refresh').onclick = poll;
$('vexa-summarize').onclick = () => action(() => api('summarize', {}), 'vexa-summary-message');
$('vexa-export').onclick = () => {
  const m = state.meeting; const content = [`# Vexa 会议记录`, '', m ? `平台：${m.platform}\n机器人：${m.botName}\n开始：${m.startedAt}` : '', '', '## 转写', '', ...(m?.segments || []).map(row => `**${clock(row.start)} ${row.speaker}${row.completed ? '' : '（草稿）'}**\n\n${row.text}\n`), '', '## Codex 纪要', '', state.summary.text || '尚未整理'].join('\n');
  const url = URL.createObjectURL(new Blob([content], {type: 'text/markdown;charset=utf-8'})); const a = document.createElement('a'); a.href = url; a.download = `Vexa会议-${new Date().toISOString().slice(0, 10)}.md`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
await api('status').then(value => {render(value); if (value.configured) feedback('vexa-key-message', 'Vexa 已验证，Key 仅保存在当前页面内存中。'); if (value.meeting) {$('meeting-url').value = value.meeting.meetingUrl || ''; $('bot-name').value = value.meeting.botName;}}).catch(error => feedback('vexa-key-message', error.message, true));
setInterval(async () => {if (state.active && state.configured) await poll(); else if (state.summary.state === 'running' && !pending && !refreshing) {try {render(await api('status'));} catch {feedback('vexa-summary-message', '在线服务连接已断开，请检查服务。', true);}}}, 4000);
window.addEventListener('beforeunload', event => {if (state.active) {event.preventDefault(); event.returnValue = '';}});

