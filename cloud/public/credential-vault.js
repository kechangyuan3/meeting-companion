// Browser-only persistence. The non-exportable key and ciphertext stay in this origin's IndexedDB.
const DATABASE = 'meeting-companion-credentials';
export function indexedStore(indexedDB = globalThis.indexedDB) {
  async function open() {
    if (!indexedDB) throw Error('当前浏览器不支持保存凭据，请在普通浏览窗口中使用。');
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('vault');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(Error('无法打开浏览器凭据存储。'));
      request.onblocked = () => reject(Error('请关闭此网站的其他标签页后重试。'));
    });
  }
  async function transaction(mode, action) {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('vault', mode);
        const request = action(tx.objectStore('vault'));
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = tx.onabort = () => reject(Error('浏览器未能保存或读取凭据，请检查存储权限。'));
      });
    } finally { db.close(); }
  }
  return {
    get: () => transaction('readonly', store => store.get('xf')),
    put: value => transaction('readwrite', store => store.put(value, 'xf')),
    clear: () => transaction('readwrite', store => store.delete('xf')),
  };
}
export function createCredentialVault({store = indexedStore(), crypto = globalThis.crypto} = {}) {
  let pending = Promise.resolve();
  const serial = action => { const next = pending.then(action); pending = next.catch(() => {}); return next; };
  function credentials(value) {
    const data = Object.fromEntries(['appId', 'apiKey', 'apiSecret'].map(key => [key, String(value?.[key] || '').trim()]));
    if (Object.values(data).some(text => !text || text.length > 1024)) throw Error('请先填写完整的 APPID、APIKey 和 APISecret。');
    return data;
  }
  return {
    save: value => serial(async () => {
      const data = credentials(value);
      if (!crypto?.subtle) throw Error('当前浏览器不支持凭据加密，请使用 HTTPS 普通浏览窗口。');
      const key = await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt({name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('meeting-companion:xf:v1')}, key, new TextEncoder().encode(JSON.stringify(data)));
      await store.put({version: 1, key, iv, encrypted});
    }),
    load: () => serial(async () => {
      const saved = await store.get();
      if (!saved) return null;
      try {
        if (saved.version !== 1) throw Error('version');
        const raw = await crypto.subtle.decrypt({name: 'AES-GCM', iv: saved.iv, additionalData: new TextEncoder().encode('meeting-companion:xf:v1')}, saved.key, saved.encrypted);
        return credentials(JSON.parse(new TextDecoder().decode(raw)));
      } catch { throw Error('已保存的讯飞凭据无法读取，请清除后重新保存。'); }
    }),
    clear: () => serial(() => store.clear()),
  };
}
