import {PcmPlayer} from './media/pcm-player.js';

// 讯飞星火「超拟人交互」页面端：经本站 /connect-xf 中转，全双工持续上传麦克风 PCM，
// 拼出参会者字幕（讯飞听写 JSON：sn/pgs/rg/ws）和 AI 回复字幕，并播放回复语音。
// 讯飞单次连接最长 30 分钟：29 分钟时新开一条连接（沿用对话历史），接好后再切换，会议不中断。
const RENEW_MS = 29 * 60 * 1000;

export function textOf(value) {
  if (value == null) return '';
  if (typeof value === 'string') {
    const text = value.trim();
    if (text.startsWith('{') || text.startsWith('[')) {try {return textOf(JSON.parse(text));} catch {}}
    return value;
  }
  if (Array.isArray(value)) return value.map(textOf).join('');
  if (typeof value === 'object') {
    if (Array.isArray(value.ws)) return value.ws.map(item => (item.cw || []).map(word => word.w || '').join('')).join('');
    for (const key of ['text', 'content', 'answer', 'result', 'data']) if (key in value) return textOf(value[key]);
  }
  return '';
}
export function iatResult(raw) {
  let value; try {value = JSON.parse(raw);} catch {return {text: String(raw)};}
  const result = value?.text && typeof value.text === 'object' ? value.text : value?.result && typeof value.result === 'object' ? value.result : value;
  return {sn: Number(result?.sn), pgs: result?.pgs, rg: Array.isArray(result?.rg) ? result.rg.map(Number) : null, ls: result?.ls === true, text: textOf(result)};
}
const eventName = raw => /\bbos\b/i.test(raw) ? 'Bos' : /\beos\b/i.test(raw) ? 'Eos' : /silence/i.test(raw) ? 'Silence' : '';

export class XfLink {
  constructor({ctx, url, authenticate, options, on}) {
    Object.assign(this, {url, authenticate, options, on});
    this.player = new PcmPlayer(ctx);
    this.player.onPlay = () => on.speaking(true); this.player.onIdle = () => on.speaking(false);
    this.active = null; this.pending = null; this.started = false; this.closed = false; this.timer = null;
    this.utter = 0; this.segments = new Map(); this.userText = ''; this.userOpen = false;
    this.reply = 0; this.replyText = ''; this.replyOpen = false; this.rate = 24000; this.unduck = null;
  }
  start() {this.open(false);}
  open(resume) {
    const ws = new WebSocket(this.url); ws.binaryType = 'arraybuffer';
    const link = {ws, ready: false};
    ws.onopen = () => this.authenticate(ws, {...this.options, resume});
    ws.onmessage = event => this.message(link, event.data);
    ws.onclose = () => {
      if (this.closed) return;
      if (link === this.pending) {this.pending = null; return;}
      if (link === this.active) {this.closed = true; this.on.error('讯飞实时连接已断开。录音和字幕已保留，可以结束后重新开始。');}
    };
    if (!this.active) this.active = link; else this.pending = link;
  }
  message(link, data) {
    if (this.closed) return;
    if (typeof data !== 'string') {if (link === this.active) this.player.push(data, this.rate); return;}
    let message; try {message = JSON.parse(data);} catch {return;}
    if (message.type === 'local.error') {
      if (link === this.pending) {this.pending = null; try {link.ws.close();} catch {} return;}
      if (link === this.active) {this.closed = true; this.on.error(message.message);}
      return;
    }
    if (message.type === 'xf.ready') {
      link.ready = true; clearTimeout(this.timer); this.timer = setTimeout(() => this.renew(), RENEW_MS);
      if (link === this.pending) {const old = this.active; this.active = link; this.pending = null; this.retire(old);}
      else if (!this.started) {this.started = true; this.on.ready();}
      return;
    }
    if (message.type === 'xf' && link === this.active) this.event(message);
  }
  renew() {if (!this.closed && !this.pending) this.open(true);}
  retire(link) {
    if (!link) return;
    try {if (link.ws.readyState === WebSocket.OPEN) link.ws.send(JSON.stringify({action: 'local.end'}));} catch {}
    setTimeout(() => {try {link.ws.close();} catch {}}, 1000);
  }
  sendAudio(frame) {
    const ws = this.active?.ws;
    if (this.closed || !this.active?.ready || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 512000) {this.closed = true; this.on.error('上传速度跟不上麦克风音频，请检查网络后重新开始。'); return;}
    ws.send(frame);
  }
  event(message) {
    const name = message.event ? eventName(message.event) : '';
    if (name === 'Bos') {
      this.finishUser(); this.utter++; this.segments = new Map(); this.userText = ''; this.userOpen = true;
      // 有人开口时先压低 AI 的声音；讯飞若随后给出新回复就停掉旧的，否则 1.5 秒后恢复。
      if (this.player.playing) {clearTimeout(this.unduck); this.player.duck(0.25);}
    }
    if (name === 'Eos') {this.finishUser(); clearTimeout(this.unduck); this.unduck = setTimeout(() => this.player.duck(1), 1500);}
    if (message.iat != null) {
      // 最后一帧听写可能只有 status=2、没有文字，这时只把当前这句标记为说完。
      if (message.iat) this.iat(message); else if (message.iatStatus === 2) this.finishUser();
    }
    if (message.nlp != null) this.nlp(message);
    if (message.tts?.rate) this.rate = message.tts.rate;
  }
  iat(message) {
    const result = iatResult(message.iat);
    if (!this.userOpen) {this.utter++; this.segments = new Map(); this.userOpen = true;}
    if (result.pgs === 'rpl' && result.rg) for (let sn = result.rg[0]; sn <= result.rg[1]; sn++) this.segments.delete(sn);
    this.segments.set(Number.isFinite(result.sn) ? result.sn : this.segments.size + 1, result.text);
    this.userText = [...this.segments.entries()].sort((a, b) => a[0] - b[0]).map(item => item[1]).join('');
    const done = result.ls || message.iatStatus === 2;
    this.on.user(this.utter, this.userText, done);
    if (done) this.userOpen = false;
  }
  nlp(message) {
    const text = textOf(message.nlp);
    if (!this.replyOpen || message.nlpStatus === 0) {
      this.reply++; this.replyText = ''; this.replyOpen = true;
      clearTimeout(this.unduck); this.player.flush();
    }
    // 讯飞的回复可能逐段下发，也可能每次下发累计全文，两种都兼容。
    this.replyText = this.replyText && text.startsWith(this.replyText) ? text : this.replyText + text;
    const done = message.nlpStatus === 2;
    if (this.replyText) this.on.ai(this.reply, this.replyText, done);
    if (done) this.replyOpen = false;
  }
  finishUser() {if (this.userOpen && this.userText) this.on.user(this.utter, this.userText, true); this.userOpen = false;}
  close() {
    this.closed = true; clearTimeout(this.timer); clearTimeout(this.unduck);
    for (const link of [this.active, this.pending]) this.retire(link);
    this.active = this.pending = null; this.player.close();
  }
}
