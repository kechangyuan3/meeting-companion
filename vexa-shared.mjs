export class VexaError extends Error {
  constructor(message, status = 400) {super(message); this.status = status;}
}

export function parseMeetingUrl(value) {
  let url; try {url = new URL(String(value || '').trim());} catch {throw new VexaError('请粘贴完整的 HTTPS 会议邀请链接。');}
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new VexaError('请使用原始的 HTTPS 会议邀请链接。');
  const host = url.hostname.toLowerCase(); let platform, id;
  if (host === 'meet.google.com') {
    platform = 'google_meet'; id = url.pathname.match(/^\/([a-z]{3}-[a-z]{4}-[a-z]{3})\/?$/i)?.[1];
  } else if (/(^|\.)zoom\.(us|com)$/.test(host)) {
    platform = 'zoom'; id = url.pathname.match(/^\/(?:j|wc\/join)\/(\d{9,12})\/?$/)?.[1];
  } else if (['teams.microsoft.com', 'teams.live.com', 'teams.microsoft.us', 'gov.teams.microsoft.us', 'dod.teams.microsoft.us'].includes(host)) {
    platform = 'teams';
    const numeric = url.pathname.match(/^\/meet\/(\d{10,15})\/?$/)?.[1];
    const thread = url.pathname.match(/^\/l\/meetup-join\/([^/]+)(?:\/0)?\/?$/)?.[1];
    if (numeric) id = numeric;
    else if (thread) {try {id = decodeURIComponent(thread);} catch {throw new VexaError('Teams 会议链接编码不正确。');} if (!/^19:meeting_[^/]+@thread\.v2$/.test(id)) id = undefined;}
  }
  if (!id) throw new VexaError('暂不识别这个链接。请使用 Zoom 的 /j/ 链接、Google Meet 房间链接或 Teams 的完整加入链接。');
  url.hash = '';
  return {platform, nativeMeetingId: id, meetingUrl: url.href};
}

export function normalizeSegments(input) {
  if (!Array.isArray(input)) throw new VexaError('Vexa 转写响应缺少 segments 数组。', 502);
  const rows = new Map();
  for (const [index, item] of input.entries()) {
    if (!item || typeof item.text !== 'string' || !item.text.trim()) continue;
    const start = Number(item.start), end = Number(item.end);
    const key = String(item.segment_id ?? item.id ?? `${item.session_id || ''}:${Number.isFinite(start) ? start : index}:${item.speaker_id || ''}`);
    const row = {id: key, speaker: typeof item.speaker === 'string' && item.speaker.trim() ? item.speaker.trim() : '未识别发言者', text: item.text.trim(), start: Number.isFinite(start) ? start : null, end: Number.isFinite(end) ? end : null, completed: item.completed !== false};
    if (!rows.get(key)?.completed || row.completed) rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity));
}

