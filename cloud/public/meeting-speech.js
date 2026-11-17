// 按用户点击生成独立 MP3；不冒充全双工，也不在会议中自动播放。
export function createMeetingSpeech({request, configured, answer, summary, $}) {
  let controller = null, blobUrl = '', generation = 0;
  const message = (text, error = false) => {$('speech-message').textContent = text; $('speech-message').className = `feedback ${error ? 'error' : ''}`;};
  const check = () => {if (!configured()) throw Error('请先在左侧验证 MOSS Key。');};
  const clearAudio = () => {
    const audio = $('speech-audio'); audio.pause(); audio.removeAttribute('src'); audio.hidden = true;
    $('speech-download').hidden = true; $('speech-download').removeAttribute('href');
    if (blobUrl) URL.revokeObjectURL(blobUrl); blobUrl = '';
  };
  const buttons = active => {$('speech-generate').disabled = active; $('speech-cancel').hidden = !active;};
  async function jsonCall(path, data = {}, signal) {
    const response = await request(path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data), signal});
    if (!response.ok) {const body = await response.json().catch(() => ({})); throw Error(body.error || `请求失败（HTTP ${response.status}）。`);}
    return response;
  }
  $('speech-voices-load').onclick = async () => {
    $('speech-voices-load').disabled = true;
    try {
      check(); const data = await (await jsonCall('/api/moss/voices', {}, AbortSignal.timeout(30000))).json();
      const select = $('speech-voices'); select.replaceChildren();
      const empty = document.createElement('option'); empty.value = ''; empty.textContent = '选择音色，或在下方填入音色 ID'; select.append(empty);
      for (const voice of data.voices) {const option = document.createElement('option');option.value = voice.id;option.textContent = voice.name || voice.id;select.append(option);}
      message(data.voices.length ? `已读取 ${data.voices.length} 个可用音色${data.hasMore ? '；更多音色可从 MOSS Create 复制 ID' : ''}。` : '账户暂无可用音色，可从 MOSS Create 音色库复制音色 ID。');
    } catch (error) {message(error.message, true);} finally {$('speech-voices-load').disabled = false;}
  };
  $('speech-voices').onchange = () => {$('speech-voice-id').value = $('speech-voices').value;};
  function fill(text) {
    if (!text) return message('当前还没有可填入的内容，请先生成 Nex 回答或会后纪要。');
    $('speech-text').value = text.slice(0, 5000);message(text.length > 5000 ? '已填入前 5000 字符，请检查后再生成。' : '已填入内容，检查后点击“生成朗读音频”。');
  }
  $('speech-from-answer').onclick = () => fill(answer());
  $('speech-from-summary').onclick = () => fill(summary());
  $('speech-generate').onclick = async () => {
    if (controller) return;
    let current;
    try {
      check(); const text = $('speech-text').value.trim(), voiceId = $('speech-voice-id').value.trim();
      if (!text || text.length > 5000) throw Error('请填写 1–5000 字符的朗读内容。');
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(voiceId)) throw Error('请先选择音色或填写有效的音色 ID。');
      controller = new AbortController(); current = ++generation; buttons(true); clearAudio();
      message('正在生成朗读音频，生成按字符计费，请稍候…');
      const response = await jsonCall('/api/moss/speech', {model: $('speech-model').value, voiceId, text}, AbortSignal.any([controller.signal, AbortSignal.timeout(185000)]));
      if (!response.headers.get('Content-Type')?.startsWith('audio/')) throw Error('服务没有返回音频，请刷新后重试。');
      const blob = await response.blob(); if (current !== generation) return;
      if (!blob.size) throw Error('生成的音频为空。');
      blobUrl = URL.createObjectURL(blob); $('speech-audio').src = blobUrl; $('speech-audio').hidden = false;
      $('speech-download').href = blobUrl; $('speech-download').hidden = false;
      message('朗读音频已生成。点击播放器播放，也可以下载 MP3。');
    } catch (error) {if (current == null || current === generation) message(error.name === 'AbortError' ? '已停止生成。' : error.message, error.name !== 'AbortError');}
    finally {if (current == null || current === generation) {controller = null;buttons(false);}}
  };
  $('speech-cancel').onclick = () => controller?.abort();
  return {clear() {generation++; controller?.abort();controller = null;buttons(false);clearAudio();$('speech-text').value = '';message('');}};
}
