import {pcm16ToFloat} from './pcm.js';

// 按到达顺序连续播放 16 bit PCM 片段（讯飞回复为 24 kHz）。flush 立即停掉已排队的声音，duck 临时压低音量。
export class PcmPlayer {
  constructor(ctx) {
    this.ctx = ctx; this.gain = ctx.createGain(); this.gain.connect(ctx.destination);
    this.sources = new Set(); this.at = 0; this.onPlay = null; this.onIdle = null;
  }
  get playing() {return this.sources.size > 0;}
  push(buffer, rate = 24000) {
    const samples = pcm16ToFloat(new Uint8Array(buffer));
    if (!samples.length) return;
    const clip = this.ctx.createBuffer(1, samples.length, rate); clip.copyToChannel(samples, 0);
    const source = this.ctx.createBufferSource(); source.buffer = clip; source.connect(this.gain);
    const now = this.ctx.currentTime; if (this.at < now + 0.04) this.at = now + 0.08;
    source.start(this.at); this.at += clip.duration;
    const wasIdle = !this.playing; this.sources.add(source);
    source.onended = () => {this.sources.delete(source); if (!this.playing) this.onIdle?.();};
    if (wasIdle) this.onPlay?.();
  }
  flush() {
    const had = this.playing;
    for (const source of this.sources) {source.onended = null; try {source.stop();} catch {}}
    this.sources.clear(); this.at = 0; this.duck(1);
    if (had) this.onIdle?.();
  }
  duck(level) {this.gain.gain.setTargetAtTime(level, this.ctx.currentTime, 0.04);}
  close() {this.flush(); try {this.gain.disconnect();} catch {}}
}
