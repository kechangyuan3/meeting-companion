import {BACKEND_ORIGIN} from './service-config.js';

export function serviceUrls(backend = BACKEND_ORIGIN, pageOrigin = location.origin) {
  const origin = new URL(backend || pageOrigin);
  if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw Error('后台地址配置不正确。');
  const pathOnly = path => {if (!/^\/(?:api\/|connect(?:-xf)?$)/.test(path) || /[?#\\]/.test(path)) throw Error('服务路径不正确。');return path;};
  return {
    api: path => origin.origin + pathOnly(path),
    socket: path => origin.origin.replace(/^http/, 'ws') + pathOnly(path),
  };
}
export const apiUrl = path => serviceUrls().api(path);
export const socketUrl = path => serviceUrls().socket(path);
