import {Microphone} from './media/mic.js';
import {Speaker} from './media/speaker.js';
import {PublicSession} from './media/public-session.js';
import {MeetingRecorder} from './media/recorder.js';
import {createRecap} from './recap.js';

const $ = id => document.getElementById(id);
let configured = false, socket, microphone, session, audio, ticker, elapsedTimer, startedAt, epoch = 0, muted = false;
let preservedError = false, backendPolling = null;
let recorder = null, meetingEpoch = 0, meetingStartedAt = 0;
const messages = new Map(), taskCards = new Map();
const api = async (path, data) => {
  const response = await fetch(path, data === undefined ? {} : {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data)});
  const value = await response.json(); if (!response.ok) throw Error(value.error || '请求失败'); return value;
};
// 会后整理（MOSS-Transcribe-Diarize-Pro 分人转写 + Nex N2.6 纪要），Key 由本机服务保管。
const recap = createRecap({request: (path, init) => fetch(path, init), $});
function feedback(id, text, type = '') {$(id).textContent = text; $(id).className = `feedback ${type}`;}
function notice(text) {$('notice').textContent = text; $('notice').hidden = !text;}
function status(kind, title, subtitle) {
  $('orb').className = `orb ${kind}`; $('live-dot').className = `live-dot ${['listening', 'speaking'].includes(kind) ? 'active' : ''}`;
  $('connection-label').textContent = ({offline: '准备开始', connecting: '连接中', listening: '会议进行中', speaking: '小莫正在说话', error: '需要检查连接'})[kind] || '准备开始';
  if (title) $('meeting-title').textContent = title; if (subtitle) $('meeting-subtitle').textContent = subtitle;
}
async function refreshStatus() {
  const data = await api('/api/status'); configured = data.configured;
  $('key-badge').textContent = data.verified ? '已验证' : configured ? '已配置' : '待填写';
  $('key-badge').className = `badge ${configured ? 'ready' : ''}`;
  if (!socket) $('start').disabled = !configured;
  $('test-backend').disabled = !data.backendAvailable;
  $('backend-badge').textContent = data.backendAvailable ? 'Codex 已就绪' : '未找到 Codex';
  $('backend-badge').className = `badge ${data.backendAvailable ? 'ready' : ''}`;
  if (data.backendTest?.state === 'passed') {feedback('backend-message', '后台连接成功，可以接收查询任务。', 'ok'); $('test-backend').disabled = false; clearInterval(backendPolling);}
  if (data.backendTest?.state === 'failed') {feedback('backend-message', data.backendTest.error || '后台检测未通过，请检查 Codex 登录。', 'error'); $('test-backend').disabled = false; clearInterval(backendPolling);}
  return data;
}
$('save-key').onclick = async () => {
  const key = $('api-key').value.trim(); $('save-key').disabled = true; feedback('key-message', '正在验证 MOSS 密钥…');
  try {await api('/api/configure', {apiKey: key}); $('api-key').value = ''; $('api-key').placeholder = '密钥已配置，替换时重新粘贴'; await refreshStatus(); feedback('key-message', '密钥已验证，可以开始会议。', 'ok');}
  catch (error) {feedback('key-message', error.message, 'error');}
  finally {$('save-key').disabled = false;}
};
$('test-backend').onclick = async () => {
  $('test-backend').disabled = true; feedback('backend-message', '正在检测 Codex，通常需要十几秒…');
  try {await api('/api/test-backend', {}); backendPolling = setInterval(() => refreshStatus().catch(() => {}), 2000);}
  catch (error) {feedback('backend-message', error.message, 'error'); $('test-backend').disabled = false;}
};
async function devices() {
  const selected = $('microphone').value;
  const list = await navigator.mediaDevices.enumerateDevices(); $('microphone').replaceChildren(new Option('系统默认麦克风', ''));
  list.filter(device => device.kind === 'audioinput' && device.deviceId && device.deviceId !== 'default' && device.deviceId !== 'communications').forEach((device, index) => $('microphone').add(new Option(device.label || `麦克风 ${index + 1}（授权后显示名称）`, device.deviceId)));
  if ([...$('microphone').options].some(option => option.value === selected)) $('microphone').value = selected;
}
$('refresh-devices').onclick = () => devices().catch(() => notice('暂时无法读取设备列表，开始会议时请选择允许麦克风。'));
function setControls(active) {
  $('start').disabled = active || !configured; $('stop').disabled = !active; $('mute').disabled = !active;
  for (const id of ['nickname', 'mode', 'microphone', 'save-key']) $(id).disabled = active;
}
function addMessage(key, who, text, done) {
  if (!text?.trim()) return;
  let record = messages.get(key);
  if (!record) {
    $('empty')?.remove();
    const element = document.createElement('div'); element.className = `message ${who === 'ai' ? 'ai' : ''}`;
    const avatar = document.createElement('div'); avatar.className = 'avatar'; avatar.textContent = who === 'ai' ? '莫' : '会';
    const main = document.createElement('div'); main.className = 'message-main';
    const meta = document.createElement('div'); meta.className = 'message-meta';
    const name = document.createElement('span'); name.textContent = who === 'ai' ? ($('nickname').value || '小莫') : '参会者';
    const time = document.createElement('time'); time.textContent = new Date().toLocaleTimeString('zh-CN', {hour12: false});
    const content = document.createElement('div'); content.className = 'message-text';
    meta.append(name, time); main.append(meta, content); element.append(avatar, main); $('transcript').append(element);
    record = {element, content, who, name: name.textContent, time: time.textContent}; messages.set(key, record);
  }
  record.content.textContent = text; record.text = text; record.element.classList.toggle('pending', !done);
  $('transcript-count').textContent = `${messages.size} 条`;
  $('transcript').scrollTop = $('transcript').scrollHeight;
}
function task(message) {
  if (!message.id) return;
  let card = taskCards.get(message.id);
  if (!card) {
    $('tasks-empty')?.remove(); const element = document.createElement('div'); const label = document.createElement('span'); const title = document.createElement('span');
    label.className = 'task-status'; title.className = 'task-title'; element.append(label, title); $('tasks').prepend(element); card = {element, label, title}; taskCards.set(message.id, card);
  }
  card.element.className = `task ${message.status}`;
  card.label.textContent = ({queued: '排队中', running: '查询中', progress: '进行中', returning: '回传中', completed: '已完成', cancelled: '已取消', failed: '未完成'})[message.status] || '处理中';
  card.title.textContent = message.title || '后台任务';
}
function conversationOf(value) {
  return [...messages.entries()].filter(([key]) => key.split(':')[1] === String(value)).map(([, record]) => ({who: record.who, text: record.text}));
}
async function stop({keepError = false, recap: recapMode = keepError ? 'manual' : 'auto'} = {}) {
  epoch++; const activeRecorder = recorder; recorder = null;
  const recorded = activeRecorder ? await activeRecorder.finish().catch(() => []) : [];
  microphone?.close(); microphone = null; session?.close(); session = null;
  clearInterval(ticker); clearInterval(elapsedTimer); const old = socket; socket = null;
  if (old && old.readyState < WebSocket.CLOSING) old.close();
  if (audio && audio.state !== 'closed') await audio.close().catch(() => {});
  audio = null; muted = false; $('mute').textContent = '暂停收音'; $('mic-level').value = 0; setControls(false);
  if (!keepError) status('offline', '本次会议已结束', '可以导出文字，或再开始一场新的讨论。');
  if (activeRecorder && recapMode !== 'none') {
    const nickname = $('nickname').value.trim() || '小莫';
    recap.ready(recorded, {startedAt: meetingStartedAt, nickname, keyterms: [...new Set([nickname, '小莫', 'MOSS'])], conversation: conversationOf(meetingEpoch)}, {auto: recapMode === 'auto'});
  }
}
function fail(text) {preservedError = true; notice(text); status('error', '连接需要检查', '修复后可以重新开始，现有字幕仍保留在页面中。'); void stop({keepError: true});}
async function start() {
  const current = ++epoch; preservedError = false; notice(''); setControls(true); status('connecting', '准备加入讨论', '请在浏览器提示中允许使用麦克风。');
  let localMic;
  try {
    audio = new AudioContext({sampleRate: 48000}); await audio.resume();
    localMic = await Microphone.open({ctx: audio, deviceId: $('microphone').value || undefined, noiseSuppression: false,
      onLevel: level => {if (current === epoch) $('mic-level').value = level;},
      onFrame: frame => {
        if (current !== epoch || socket?.readyState !== WebSocket.OPEN) return;
        if (socket.bufferedAmount > 512000) return fail('上传速度跟不上麦克风音频，请检查网络后重新开始。');
        // Plain PCM is sent; MOSS defaults to the public PCM protocol.
        socket.send(frame);
      }});
    if (current !== epoch) {localMic.close(); return;}
    microphone = localMic; await devices();
    status('connecting', '正在连接 MOSS', '麦克风已准备好，等待实时会话。');
    const ws = new WebSocket(`ws://${location.host}/connect`); socket = ws; ws.binaryType = 'arraybuffer';
    const send = message => {if (current === epoch && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));};
    session = new PublicSession(send);
    session.speaker = new Speaker({ctx: audio, ledger: session.ledger, onMessages: values => session.messages(values)});
    ticker = setInterval(() => {if (session && audio) session.speaker.tick(audio.currentTime);}, 20);
    let micStarted = false, inputSerial = 0, pendingInput = null;
    ws.onmessage = async event => {
      if (current !== epoch) return;
      try {
        if (typeof event.data !== 'string') {session.audio(event.data); return;}
        const message = JSON.parse(event.data); const data = message.data || {};
        if (message.type === 'local.error') return fail(message.message);
        if (message.type === 'local.task') return task(message);
        session.text(message);
        if (message.action === 'session_attached') {
          const nickname = $('nickname').value.trim() || '小莫';
          const behaviour = $('mode').value === 'listen' ? '平时安静旁听，不主动插话；被叫到时再总结或回答。' : '自然参与会议。参会者之间的讨论保持旁听；听到你的名字、明确向你提问、或等待你的查询结论时，简洁回应。';
          send({action: 'session.update', session: {
            persona: {name: nickname, aliases: [...new Set(['小莫', 'MOSS', '助手', nickname])], prompt: `你叫${nickname}，是线下多人会议的 AI 参会者。用自然中文交流，语气亲切、简洁。${behaviour}区分对你的提问与参会者之间的对话。被真正打断时停止旧回答；“嗯”“好的”等附和不需要重新回答。记住讨论的决定、分歧、待办和负责人。需要实时天气、活动、事实核实、复杂研究或长任务时，把任务委派给客户后台执行，等结果返回后择机汇报；后台查询期间继续听取讨论。不要编造已经查询到的结果。被要求整理结论时，分别说明决定和待办，不虚构负责人。`},
            instructions: '这是电脑麦克风收音的线下会议。后台由 Codex 负责资料查询与整理，已支持客户端委派。涉及实时信息时应使用后台查询。短回复优先，避免长篇独白。',
            tools: [{type: 'function', name: 'get_local_time', description: '获取参会者电脑的当前时间', parameters: {type: 'object', properties: {}, additionalProperties: false}}],
          }});
        }
        if (message.action === 'session.updated') {
          if (data.error) throw Error('MOSS 未接受会议配置，请检查实时模型权限。');
          if (!micStarted) {micStarted = true; await microphone.start(); if (current !== epoch) return; send({action: 'mic_state', enabled: true});
            recap.reset(); meetingEpoch = current; meetingStartedAt = Date.now();
            if (MeetingRecorder.supported()) {recorder = new MeetingRecorder(microphone.stream); recorder.start();}
            else notice('当前浏览器不支持录音，会后无法生成分人转写和纪要。');
            startedAt = Date.now(); elapsedTimer = setInterval(() => {const seconds = Math.floor((Date.now() - startedAt) / 1000); $('duration').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;}, 1000);
            status('listening', '小莫已入席', '可以开始讨论。需要帮忙时，叫一声“小莫”。');}
        }
        if (message.action.startsWith('input.transcript.')) {
          if (!pendingInput) pendingInput = `user:${current}:${++inputSerial}`;
          const key = data.turn ? `user:${current}:${data.turn}` : pendingInput;
          addMessage(key, 'user', data.text, message.action !== 'input.transcript.updated');
          if (message.action === 'input.transcript.done') pendingInput = null;
        }
        if (message.action.startsWith('output.transcript.')) addMessage(`ai:${current}:${data.run_id || 'current'}`, 'ai', data.text, message.action === 'output.transcript.done');
        if (message.action === 'response.audio.started') status('speaking', '小莫正在回应', '你可以随时开口补充或打断。');
        if (['response.interrupted', 'response.ended'].includes(message.action) && micStarted) status('listening', '小莫在听', '讨论可以继续，需要帮忙时叫“小莫”。');
        if (message.action === 'error') notice(`MOSS 请求提示：${data.error?.code || '请检查账户和网络'}。`);
      } catch (error) {fail(error.message);}
    };
    ws.onerror = () => {if (current === epoch && !preservedError) fail('连接未成功。请先验证 MOSS Key，并检查网络连接。');};
    ws.onclose = () => {if (current === epoch && !preservedError) {notice('实时连接已关闭。可重新开始会议。'); void stop();}};
  } catch (error) {
    localMic?.close(); if (current !== epoch) return;
    const message = error.name === 'NotAllowedError' ? '麦克风尚未授权。请点击浏览器地址栏的权限图标，允许本机页面使用麦克风后重新开始。' : error.name === 'NotFoundError' ? '没有找到麦克风，请连接设备后重试。' : error.name === 'NotReadableError' ? '麦克风无法使用，可能正被其他程序独占。请关闭独占录音后重试。' : error.message;
    fail(message);
  }
}
$('start').onclick = start;
$('stop').onclick = async () => {await stop(); await api('/api/stop', {}).catch(() => {});};
$('mute').onclick = () => {if (!microphone) return; muted = !muted; microphone.setMuted(muted); microphone.stream.getAudioTracks().forEach(track => {track.enabled = !muted;}); socket?.send(JSON.stringify({action: 'mic_state', enabled: !muted})); $('mute').textContent = muted ? '继续收音' : '暂停收音';};
$('export').onclick = () => {
  if (!messages.size) return notice('还没有可以导出的对话文字。');
  const text = '# MOSS 会议对话\n\n' + [...messages.values()].map(record => `**${record.name} · ${record.time}**\n\n${record.text}`).join('\n\n');
  const url = URL.createObjectURL(new Blob([text], {type: 'text/markdown;charset=utf-8'})); const link = document.createElement('a'); link.href = url; link.download = `MOSS会议-${new Date().toISOString().slice(0, 10)}.md`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$('shutdown').onclick = async () => {await stop({recap: 'none'}); await api('/api/shutdown', {}); $('meeting-title').textContent = '服务已退出'; $('meeting-subtitle').textContent = '下次双击“启动会议.vbs”即可重新打开。'; $('start').disabled = true;};
window.addEventListener('pagehide', () => {microphone?.close(); session?.close(); socket?.close();});
refreshStatus().catch(error => notice(error.message)); devices().catch(() => {});
setInterval(() => {if (!document.hidden && !socket) refreshStatus().catch(() => {});}, 3000);
