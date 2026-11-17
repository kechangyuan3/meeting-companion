// 会中录下麦克风音频，会后交给 MOSS-Transcribe-Diarize-Pro 生成分人转写。
// diarize-pro 单次最长 60 分钟，所以每 55 分钟切一段；暂停收音时录到的是静音，时间轴保持连续。

const TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'];
export const PART_SECONDS = 55 * 60;

export class MeetingRecorder {
  static supported() {
    return typeof MediaRecorder !== 'undefined' && TYPES.some(type => MediaRecorder.isTypeSupported(type));
  }

  constructor(stream, {partSeconds = PART_SECONDS} = {}) {
    this.stream = stream;
    this.mimeType = TYPES.find(type => MediaRecorder.isTypeSupported(type));
    this.partSeconds = partSeconds;
    this.parts = [];
    this.current = null;
    this.timer = null;
  }

  start() {
    this.startedAt = Date.now();
    this.startPart();
  }

  startPart() {
    const recorder = new MediaRecorder(this.stream, {mimeType: this.mimeType, audioBitsPerSecond: 32000});
    const part = {chunks: [], offset: (Date.now() - this.startedAt) / 1000, recorder};
    part.done = new Promise(resolve => recorder.addEventListener('stop', resolve, {once: true}));
    recorder.addEventListener('dataavailable', event => {if (event.data?.size) part.chunks.push(event.data);});
    recorder.start(10000);
    this.current = part;
    this.parts.push(part);
    this.timer = setTimeout(() => {
      if (this.current !== part) return;
      part.recorder.stop();
      this.startPart();
    }, this.partSeconds * 1000);
  }

  // 停止录音，返回 [{blob, offset}]，offset 为该段在会议中的起始秒数。
  async finish() {
    clearTimeout(this.timer);
    const part = this.current; this.current = null;
    if (part && part.recorder.state !== 'inactive') part.recorder.stop();
    // 个别浏览器偶尔不触发 stop 事件，最多等 5 秒，已收到的数据照样保留。
    await Promise.race([Promise.all(this.parts.map(item => item.done)), new Promise(resolve => setTimeout(resolve, 5000))]);
    const type = this.mimeType.split(';')[0];
    return this.parts.map(item => ({blob: new Blob(item.chunks, {type}), offset: item.offset})).filter(item => item.blob.size > 2048);
  }
}
