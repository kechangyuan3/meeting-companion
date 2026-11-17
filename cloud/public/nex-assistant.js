// Nex N2.6 是独立的会中文字助手。只发送当前页面选择的字幕，不接收麦克风音频。
export function createNexAssistant({request, configured, conversation, $}) {
  let history = [], entries = [], running = null, generation = 0;
  const log = $('nex-log'), form = $('nex-form'), question = $('nex-question');
  function message(text, error = false) {$('nex-message').textContent = text; $('nex-message').className = `feedback ${error ? 'error' : ''}`;}
  function controls(active) {$('nex-ask').disabled = active; $('nex-cancel').hidden = !active; for (const button of document.querySelectorAll('[data-nex-question]')) button.disabled = active;}
  function refresh() {$('nex-badge').textContent = configured() ? 'MOSS Key 已验证' : '需验证 MOSS Key'; $('nex-badge').className = `badge ${configured() ? 'ready' : ''}`;}
  function row(who, text) {
    $('nex-empty')?.remove();
    const element = document.createElement('div'), label = document.createElement('div'), content = document.createElement('div');
    element.className = `nex-row ${who === 'Nex N2.6' ? 'nex-answer' : ''}`; label.className = 'nex-role'; label.textContent = who; content.className = 'nex-text'; content.textContent = text;
    element.append(label, content); log.append(element); log.scrollTop = log.scrollHeight; return content;
  }
  async function ask(text = question.value) {
    if (running) return;
    if (!configured()) {message('先在左侧填写并验证 MOSS Key，Nex 与实时语音使用同一个 MOSS 账户。', true); $('api-key').focus(); return;}
    text = String(text || '').trim(); if (!text || text.length > 8000) {message('请填写 1–8000 字符的问题。', true); return;}
    const controller = new AbortController(), current = ++generation; running = controller; controls(true); refresh();
    const context = $('nex-use-context').checked ? conversation() : [];
    row('你', text); const output = row('Nex N2.6', '正在思考…'); question.value = '';
    message(context.length ? `已带入当前会议 ${context.length} 条字幕；正在生成文字回答，语音交流可以继续。` : '正在生成文字回答；这次未附带会议字幕。');
    let answer = '';
    try {
      const response = await request('/api/moss/ask', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({question: text, conversation: context, history}), signal: controller.signal});
      if (!response.ok) {const error = await response.json().catch(() => ({})); throw Error(error.error || `Nex 请求失败（HTTP ${response.status}）。`);}
      if (!response.headers.get('content-type')?.startsWith('text/plain') || !response.body) throw Error('在线服务未返回 Nex 文字，请刷新页面后重试。');
      const reader = response.body.getReader(), decoder = new TextDecoder();
      try {while (true) {const part = await reader.read(); if (current !== generation) {await reader.cancel(); return;} if (part.done) break; answer += decoder.decode(part.value, {stream: true}); output.textContent = answer; log.scrollTop = log.scrollHeight;}}
      finally {reader.releaseLock();}
      answer += decoder.decode(); if (!answer.trim()) throw Error('Nex 未返回回答，可以缩短问题后重试。');
      output.textContent = answer; entries.push({question: text, answer});
      history = [...history, {role: 'user', content: text}, {role: 'assistant', content: answer.slice(-16000)}].slice(-16);
      message(answer.includes('> 注意：') ? '回答可能未生成完整，请查看末尾提示后重试。' : 'Nex 回答完成。以上是 AI 建议，请结合会议原话核对。', answer.includes('> 注意：'));
    } catch (error) {
      if (current !== generation) return;
      if (error.name === 'AbortError') {output.textContent = answer || '已停止生成。'; message('已停止生成，已有文字保留。');}
      else {output.textContent = answer || '这次没有生成回答。'; message(error.message || 'Nex 暂时不可用，请稍后重试。', true);}
    } finally {if (current === generation) {running = null; controls(false);}}
  }
  form.onsubmit = event => {event.preventDefault(); void ask();};
  $('nex-cancel').onclick = () => running?.abort();
  for (const button of document.querySelectorAll('[data-nex-question]')) button.onclick = () => {question.value = button.dataset.nexQuestion; void ask();};
  $('nex-clear').onclick = () => {generation++; running?.abort(); running = null; history = []; entries = []; log.replaceChildren(); controls(false); message('已清空本页 Nex 问答，会议字幕不受影响。');};
  $('nex-export').onclick = () => {
    if (!entries.length) return message('尚无完整回答可导出。');
    const text = '# Nex N2.6 · 会议问答\n\n' + entries.map(item => `## 问：${item.question}\n\n${item.answer}`).join('\n\n');
    const url = URL.createObjectURL(new Blob([text], {type: 'text/markdown;charset=utf-8'})), link = document.createElement('a');link.href = url;link.download = 'Nex-N2.6-会议问答.md';link.click();setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  refresh();return {refresh, cancel: () => running?.abort(), ask, lastAnswer: () => entries.at(-1)?.answer || ''};
}
