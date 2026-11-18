import {mossApi,authenticateMoss,mossRequest,xfConfigure,xfConfigured,xfForget,xfMarkUnverified,mossConfigured,authenticateXf,currentXfCredentials} from './cloud-api.js';
import {createCredentialVault} from './credential-vault.js';
import {XfLink} from './xf-link.js';
import {Microphone} from './media/mic.js';
import {Speaker} from './media/speaker.js';
import {PublicSession} from './media/public-session.js';
import {MeetingRecorder} from './media/recorder.js';
import {createRecap} from './recap.js';
import {createNexAssistant} from './nex-assistant.js';
import {createMeetingSpeech} from './meeting-speech.js';
import {socketUrl} from './service-base.js';

const $ = id => document.getElementById(id);
let configured = false, socket, microphone, session, audio, ticker, elapsedTimer, startedAt, epoch = 0, muted = false;
let preservedError = false, backendPolling = null;
let recorder = null, meetingEpoch = 0, meetingStartedAt = 0, xfLink = null;
let mossTransportReady = false;
// 会中对话用 MOSS-Live 还是讯飞星火超拟人交互；录音和会后整理两种都一样。
const engine = () => $('engine').value;
const ready = () => engine() === 'xf' ? xfConfigured() : configured;
function updateStart() {
  if (engine() === 'xf') {$('key-badge').textContent = xfConfigured() ? '已验证' : '待填写'; $('key-badge').className = `badge ${xfConfigured() ? 'ready' : ''}`;}
  if (!socket && !xfLink) $('start').disabled = !ready();
}
const messages = new Map(), taskCards = new Map();
const api = mossApi;
const xfVault = createCredentialVault();
let xfStorageEpoch = 0;
const xfForm = () => ({appId: $('xf-appid').value, apiKey: $('xf-apikey').value, apiSecret: $('xf-apisecret').value});
function xfForSaving() {
  const values = xfForm(), current = currentXfCredentials();
  // Blank secret fields after validation may reuse the current in-memory credentials.
  if (current && values.appId.trim() === current.appId && !values.apiKey.trim() && !values.apiSecret.trim()) return current;
  return values;
}
async function saveXfHere(values = xfForSaving()) {
  await xfVault.save(values);
  $('xf-remember').checked = true;
  feedback('xf-storage-message', '已加密保存在此浏览器，下次打开自动填入；其他设备和浏览器需要各自保存。', 'ok');
}
async function clearSavedXf() {
  xfStorageEpoch++;
  await xfVault.clear(); $('xf-remember').checked = false;
  feedback('xf-storage-message', '此浏览器保存的讯飞凭据已清除。');
}
$('xf-remember-save').onclick = async () => {
  $('xf-remember-save').disabled = true;
  try {await saveXfHere();} catch (error) {feedback('xf-storage-message', error.message, 'error');}
  finally {$('xf-remember-save').disabled = false;}
};
$('xf-remember').onchange = async () => {
  if (!$('xf-remember').checked) {
    try {await clearSavedXf();} catch (error) {feedback('xf-storage-message', error.message, 'error');}
  }
};
$('xf-remember-clear').onclick = async () => {
  try {
    await clearSavedXf(); xfForget();
    for (const id of ['xf-appid', 'xf-apikey', 'xf-apisecret']) {$(id).value = ''; $(id).placeholder = '';}
    $('xf-badge').textContent = '待填写'; $('xf-badge').className = 'badge';
    feedback('xf-message', '讯飞凭据已清除，请重新填写后验证。'); updateStart();
  } catch (error) {feedback('xf-storage-message', error.message, 'error');}
};
async function restoreXfHere() {
  const current = xfStorageEpoch;
  try {
    const saved = await xfVault.load();
    if (current !== xfStorageEpoch || !saved || Object.values(xfForm()).some(value => value.trim())) return;
    $('xf-appid').value = saved.appId; $('xf-apikey').value = saved.apiKey; $('xf-apisecret').value = saved.apiSecret;
    $('xf-remember').checked = true; $('engine').value = 'xf'; showEngine();
    feedback('xf-storage-message', '已从此浏览器恢复凭据，点击“验证讯飞服务”检查授权和额度。', 'ok');
  } catch (error) {feedback('xf-storage-message', error.message, 'error');}
}
// 会后整理（MOSS-Transcribe-Diarize-Pro 分人转写 + Nex N2.6 纪要），请求附上当前页面的 Key。
const recap = createRecap({request: mossRequest, $});
const nexAssistant = createNexAssistant({request: mossRequest, configured: mossConfigured, conversation: () => recap.context().length ? recap.context() : conversationOf(meetingEpoch), $});
const meetingSpeech = createMeetingSpeech({request: mossRequest, configured: mossConfigured, answer: nexAssistant.lastAnswer, summary: recap.summary, $});
$('audio-import').onclick = () => {
  try {
    if (socket || xfLink) throw Error('请先结束当前会议，再载入其他录音。');
    const file = $('audio-file').files?.[0]; if (!file) throw Error('请先选择一份录音。');
    recap.importAudio(file);feedback('audio-import-message', '已在本页载入，尚未上传。请在下方点击“生成转写和纪要”。', 'ok');
    $('recap').scrollIntoView({behavior: 'smooth', block: 'start'});
  } catch (error) {feedback('audio-import-message', error.message, 'error');}
};
function feedback(id, text, type = '') {$(id).textContent = text; $(id).className = `feedback ${type}`;}
function notice(text) {$('notice').textContent = text; $('notice').hidden = !text;}
function status(kind, title, subtitle) {
  $('orb').className = `orb ${kind}`; $('live-dot').className = `live-dot ${['listening', 'speaking'].includes(kind) ? 'active' : ''}`;
  $('connection-label').textContent = ({offline: '准备开始', connecting: '连接中', listening: '会议进行中', speaking: '小莫正在说话', error: '需要检查连接'})[kind] || '准备开始';
  if (title) $('meeting-title').textContent = title; if (subtitle) $('meeting-subtitle').textContent = subtitle;
}
async function refreshStatus() {
  const data = await api('/api/status'); configured = data.configured;
  nexAssistant.refresh();
  $('key-badge').textContent = data.verified ? '已验证' : configured ? '已配置' : '待填写';
  $('key-badge').className = `badge ${configured ? 'ready' : ''}`;
  updateStart();
  $('test-backend').disabled = !data.backendAvailable;
  $('backend-badge').textContent = data.backendAvailable ? 'Codex 已就绪' : '实时语音';
  $('backend-badge').className = `badge ${data.backendAvailable ? 'ready' : ''}`;
  if (data.backendTest?.state === 'passed') {feedback('backend-message', '后台连接成功，可以接收查询任务。', 'ok'); $('test-backend').disabled = false; clearInterval(backendPolling);}
  if (data.backendTest?.state === 'failed') {feedback('backend-message', data.backendTest.error || '后台检测未通过，请检查 Codex 登录。', 'error'); $('test-backend').disabled = false; clearInterval(backendPolling);}
  return data;
}
function showEngine() {
  const xf = engine() === 'xf'; $('xf-box').hidden = !xf;
  $('moss-label').textContent = xf ? 'MOSS API Key（Nex 问答、转写、纪要和朗读）' : 'MOSS API Key';
  $('live-model-name').textContent = xf ? '讯飞星火 · 超拟人交互（服务内置模型）' : 'MOSS-Live 1.0';
  updateStart();
}
$('engine').onchange = showEngine;
$('xf-save').onclick = async () => {
  $('xf-save').disabled = true; feedback('xf-message', '正在连接讯飞验证密钥…');
  try {
    await xfConfigure(xfForSaving());
    if ($('xf-remember').checked) {
      try {await saveXfHere(currentXfCredentials());} catch (error) {feedback('xf-storage-message', `验证成功，但未能记住凭据：${error.message}`, 'error');}
    }
    $('xf-apikey').value = ''; $('xf-apisecret').value = ''; $('xf-apikey').placeholder = $('xf-apisecret').placeholder = '已验证，替换时重新粘贴';
    $('xf-badge').textContent = '服务试连通过'; $('xf-badge').className = 'badge ready';
    feedback('xf-message', mossConfigured() ? '讯飞业务试连通过，可以开始会议。' : '讯飞业务试连通过，可以开始会议。Nex 问答、转写、纪要和朗读还需要 MOSS Key。', 'ok'); updateStart();
  } catch (error) {$('xf-badge').textContent='服务未通过';$('xf-badge').className='badge';feedback('xf-message', error.message, 'error');updateStart();}
  finally {$('xf-save').disabled = false;}
};
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
  $('start').disabled = active || !ready(); $('stop').disabled = !active; $('mute').disabled = !active;
  for (const id of ['nickname', 'mode', 'microphone', 'save-key', 'engine', 'xf-save', 'xf-voice', 'xf-appid', 'xf-apikey', 'xf-apisecret', 'xf-remember', 'xf-remember-save', 'xf-remember-clear']) $(id).disabled = active;
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
  epoch++; mossTransportReady = false; const activeRecorder = recorder; recorder = null;
  const recorded = activeRecorder ? await activeRecorder.finish().catch(() => []) : [];
  microphone?.close(); microphone = null; session?.close(); session = null; xfLink?.close(); xfLink = null;
  clearInterval(ticker); clearInterval(elapsedTimer); const old = socket; socket = null;
  if (old && old.readyState < WebSocket.CLOSING) old.close();
  if (audio && audio.state !== 'closed') await audio.close().catch(() => {});
  audio = null; muted = false; $('mute').textContent = '暂停收音'; $('mic-level').value = 0; setControls(false);
  if (!keepError) status('offline', '本次会议已结束', '可以导出文字，或再开始一场新的讨论。');
  if (activeRecorder && recapMode !== 'none') {
    const nickname = $('nickname').value.trim() || '小莫';
    recap.ready(recorded, {startedAt: meetingStartedAt, nickname, engine: engine() === 'xf' ? '讯飞星火超拟人交互' : 'MOSS-Live', keyterms: [...new Set([nickname, '小莫', 'MOSS'])], conversation: conversationOf(meetingEpoch)}, {auto: recapMode === 'auto' && mossConfigured()});
    if (recorded.length && !mossConfigured()) feedback('recap-note', '录音已保存在本页，可以点“下载录音”。想生成转写和纪要，先在左侧填写并验证 MOSS Key，再点“生成转写和纪要”。');
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
        if (current !== epoch) return;
        if (xfLink) {xfLink.sendAudio(frame); return;}
        if (!mossTransportReady || socket?.readyState !== WebSocket.OPEN) return;
        if (socket.bufferedAmount > 512000) return fail('上传速度跟不上麦克风音频，请检查网络后重新开始。');
        // Plain PCM is sent; MOSS defaults to the public PCM protocol.
        socket.send(frame);
      }});
    if (current !== epoch) {localMic.close(); return;}
    microphone = localMic; await devices();
    if (engine() === 'xf') return startXf(current);
    status('connecting', '正在连接 MOSS', '麦克风已准备好，等待实时会话。');
    const ws = new WebSocket(socketUrl('/connect')); socket = ws; ws.onopen = () => authenticateMoss(ws); ws.binaryType = 'arraybuffer';
    const send = message => {if (current === epoch && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));};
    const resetSession = () => {
      session?.close(); try {session?.speaker?.gainNode?.disconnect();} catch {}
      session = new PublicSession(send);
      session.speaker = new Speaker({ctx: audio, ledger: session.ledger, onMessages: values => session.messages(values)});
    };
    resetSession(); mossTransportReady = false;
    ticker = setInterval(() => {if (session && audio) session.speaker.tick(audio.currentTime);}, 20);
    let micStarted = false, micStarting = null, inputSerial = 0, pendingInput = null, wireGeneration = 0, recovering = false;
    ws.onmessage = async event => {
      if (current !== epoch) return;
      try {
        if (typeof event.data !== 'string') {session.audio(event.data); return;}
        const message = JSON.parse(event.data); const data = message.data || {};
        if (message.type === 'local.error') return fail(message.message);
        if (message.type === 'local.task') return task(message);
        if (message.type === 'local.reconnecting') {
          mossTransportReady = false;
          if (!recovering) {wireGeneration++; pendingInput = null; resetSession();}
          recovering = true;
          notice(`MOSS 语音正在恢复（第 ${message.attempt} 次）。录音和已有字幕继续保留，请稍候再说。`);
          status('connecting', '正在恢复语音连接', '会议尚未结束，正在恢复原来的 MOSS 会话。');
          return;
        }
        session.text(message);
        if (message.action === 'session.closing') notice(`MOSS 连接通知${data.code != null ? `（${data.code}）` : ''}：${data.reason || '服务端即将关闭连接'}。${data.reconnect ? '正在准备恢复原会话。' : '录音和已有字幕会保留。'}`);
        if (message.action === 'session_attached') {
          const nickname = $('nickname').value.trim() || '小莫';
          const behaviour = $('mode').value === 'listen' ? '平时安静旁听，不主动插话；被叫到时再总结或回答。' : '自然参与会议。参会者之间的讨论保持旁听；听到你的名字、明确向你提问、或等待你的查询结论时，简洁回应。';
          send({action: 'session.update', session: {
            persona: {name: nickname, aliases: [...new Set(['小莫', 'MOSS', '助手', nickname])], prompt: `你叫${nickname}，是线下多人会议的 AI 参会者。用自然中文交流，语气亲切、简洁。${behaviour}区分对你的提问与参会者之间的对话。被真正打断时停止旧回答；“嗯”“好的”等附和不需要重新回答。记住讨论的决定、分歧、待办和负责人。此在线会话没有联网搜索或后台执行工具。需要实时信息时说明目前无法核实，不要编造查询结果。被要求整理结论时，分别说明决定和待办，不虚构负责人。`},
            instructions: '这是当前设备麦克风收音的会议。你可以实时交流、记住讨论并口头总结。当前会话未配置后台 Agent，不要宣称已查询外部信息。短回复优先。',
            tools: [{type: 'function', name: 'get_local_time', description: '获取参会者电脑的当前时间', parameters: {type: 'object', properties: {}, additionalProperties: false}}],
          }});
        }
        if (message.action === 'session.updated') {
          if (data.error) throw Error('MOSS 未接受会议配置，请检查实时模型权限。');
          const configurationGeneration = wireGeneration;
          if (!micStarting) micStarting = microphone.start();
          await micStarting;
          if (current !== epoch || configurationGeneration !== wireGeneration) return;
          if (!micStarted) {micStarted = true;
            recap.reset(); meetingEpoch = current; meetingStartedAt = Date.now();
            if (MeetingRecorder.supported()) {recorder = new MeetingRecorder(microphone.stream); recorder.start();}
            else notice('当前浏览器不支持录音，会后无法生成分人转写和纪要。');
            startedAt = Date.now(); elapsedTimer = setInterval(() => {const seconds = Math.floor((Date.now() - startedAt) / 1000); $('duration').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;}, 1000);
          }
          mossTransportReady = true; send({action: 'mic_state', enabled: !muted});
          if (recovering) notice('MOSS 语音已恢复；录音、字幕和会议计时继续保留。');
          status('listening', recovering ? '语音连接已恢复' : '小莫已入席', '可以开始讨论。需要帮忙时，叫一声“小莫”。');
          recovering = false;
        }
        if (message.action.startsWith('input.transcript.')) {
          if (!pendingInput) pendingInput = `user:${current}:${wireGeneration}:pending${++inputSerial}`;
          const key = data.turn ? `user:${current}:${wireGeneration}:${data.turn}` : pendingInput;
          addMessage(key, 'user', data.text, message.action !== 'input.transcript.updated');
          if (message.action === 'input.transcript.done') pendingInput = null;
        }
        if (message.action.startsWith('output.transcript.')) addMessage(`ai:${current}:${wireGeneration}:${data.run_id || 'current'}`, 'ai', data.text, message.action === 'output.transcript.done');
        if (message.action === 'response.audio.started') status('speaking', '小莫正在回应', '你可以随时开口补充或打断。');
        if (['response.interrupted', 'response.ended'].includes(message.action) && micStarted) status('listening', '小莫在听', '讨论可以继续，需要帮忙时叫“小莫”。');
        if (message.action === 'error') notice(`MOSS 请求提示：${data.error?.code || '请检查账户和网络'}。`);
      } catch (error) {fail(error.message);}
    };
    ws.onerror = () => {if (current === epoch && !preservedError) fail('连接未成功。请先验证 MOSS Key，并检查网络连接。');};
    ws.onclose = () => {if (current === epoch && !preservedError) fail('网站实时连接已断开。录音和字幕已保留，可下载后重新开始。');};
  } catch (error) {
    localMic?.close(); if (current !== epoch) return;
    const message = error.name === 'NotAllowedError' ? '麦克风尚未授权。请点击浏览器地址栏的权限图标，允许本页使用麦克风后重新开始。' : error.name === 'NotFoundError' ? '没有找到麦克风，请连接设备后重试。' : error.name === 'NotReadableError' ? '麦克风无法使用，可能正被其他程序独占。请关闭独占录音后重试。' : error.message;
    fail(message);
  }
}
// 讯飞星火超拟人交互：全双工，音频持续上传，由讯飞判断什么时候开口；录音和会后整理与 MOSS 模式相同。
function startXf(current) {
  const nickname = $('nickname').value.trim() || '小莫';
  status('connecting', '正在连接讯飞星火', '麦克风已准备好，等待实时会话。');
  const behaviour = $('mode').value === 'listen' ? '平时安静旁听，不主动插话；被叫到名字时再总结或回答。' : '参会者之间的讨论保持旁听；听到你的名字或明确向你提问时，简洁回应。';
  const prompt = `你叫${nickname}，是线下多人会议的 AI 参会者。用自然中文交流，语气亲切、简洁，每次回答尽量不超过三句话。${behaviour}区分对你的提问与参会者之间的对话，“嗯”“好的”等附和不需要回应。记住讨论的决定、分歧、待办和负责人；被要求整理结论时，分别说明决定和待办，不虚构负责人。你没有联网查询工具，需要实时信息时说明无法核实，不要编造。`;
  xfLink = new XfLink({ctx: audio, url: socketUrl('/connect-xf'), authenticate: authenticateXf,
    options: {voice: $('xf-voice').value, prompt, uid: `mc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`},
    on: {
      ready: async () => {
        if (current !== epoch) return; await microphone.start(); if (current !== epoch) return;
        recap.reset(); meetingEpoch = current; meetingStartedAt = Date.now();
        if (MeetingRecorder.supported()) {recorder = new MeetingRecorder(microphone.stream); recorder.start();}
        else notice('当前浏览器不支持录音，会后无法生成分人转写和纪要。');
        startedAt = Date.now(); elapsedTimer = setInterval(() => {const seconds = Math.floor((Date.now() - startedAt) / 1000); $('duration').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;}, 1000);
        status('listening', `${nickname}已入席（讯飞星火）`, `可以开始讨论。需要帮忙时，叫一声“${nickname}”。`);
      },
      user: (n, text, done) => {if (current === epoch) addMessage(`user:${current}:x${n}`, 'user', text, done);},
      ai: (n, text, done) => {if (current === epoch) addMessage(`ai:${current}:x${n}`, 'ai', text, done);},
      speaking: on => {if (current === epoch && recorder) status(on ? 'speaking' : 'listening', on ? `${nickname}正在回应` : `${nickname}在听`, on ? '你可以随时开口补充或打断。' : `讨论可以继续，需要帮忙时叫“${nickname}”。`);},
      error: message => {if (current === epoch && !preservedError) {xfMarkUnverified();$('xf-badge').textContent='需要检查服务';$('xf-badge').className='badge';fail(message);}},
    }});
  xfLink.start();
}
$('start').onclick = start;
$('stop').onclick = async () => {await stop(); await api('/api/stop', {}).catch(() => {});};
$('mute').onclick = () => {if (!microphone) return; muted = !muted; microphone.setMuted(muted); microphone.stream.getAudioTracks().forEach(track => {track.enabled = !muted;}); socket?.send(JSON.stringify({action: 'mic_state', enabled: !muted})); $('mute').textContent = muted ? '继续收音' : '暂停收音';};
$('export').onclick = () => {
  if (!messages.size) return notice('还没有可以导出的对话文字。');
  const text = '# MOSS 会议对话\n\n' + [...messages.values()].map(record => `**${record.name} · ${record.time}**\n\n${record.text}`).join('\n\n');
  const url = URL.createObjectURL(new Blob([text], {type: 'text/markdown;charset=utf-8'})); const link = document.createElement('a'); link.href = url; link.download = `MOSS会议-${new Date().toISOString().slice(0, 10)}.md`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$('shutdown').onclick = async () => {
  nexAssistant.cancel();
  await stop({recap: 'none'}); await api('/api/shutdown', {}); xfForget(); meetingSpeech.clear();
  nexAssistant.refresh();
  try {await clearSavedXf();} catch (error) {notice(error.message);}
  for (const id of ['xf-appid', 'xf-apikey', 'xf-apisecret', 'api-key']) $(id).value = '';
  $('xf-badge').textContent = '待填写'; $('xf-badge').className = 'badge';
  $('meeting-title').textContent = '连接已清除'; $('meeting-subtitle').textContent = '重新填写并验证所选服务的凭据，即可再次开始。'; $('start').disabled = true;
};
window.addEventListener('pagehide', () => {microphone?.close(); session?.close(); socket?.close(); meetingSpeech.clear();});
showEngine(); refreshStatus().catch(error => notice(error.message)); devices().catch(() => {});
void restoreXfHere();
setInterval(() => {if (!document.hidden && !socket && !xfLink) refreshStatus().catch(() => {});}, 3000);
