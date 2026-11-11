import {access, mkdir, writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname, join, delimiter} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startMeeting} from './server.mjs';
const root = dirname(fileURLToPath(import.meta.url));
export async function boot() {
  let codexPath = process.env.CODEX_PATH || '';
  if (!codexPath) {
    const names = process.platform === 'win32' ? ['codex.exe'] : ['codex'];
    search: for (const directory of (process.env.PATH || '').split(delimiter)) for (const name of names) {
      const candidate = join(directory, name); try {await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK); codexPath = candidate; break search;} catch {}
    }
  }
  const app = await startMeeting({port:Number(process.env.MOSS_MEETING_PORT || 17860),codexPath:codexPath || undefined,proxyUrl:process.env.CODEX_PROXY || undefined});
  await mkdir(join(root,'.state'),{recursive:true});
  await writeFile(join(root,'.state/service.json'),JSON.stringify({pid:process.pid,url:app.url,startedAt:new Date().toISOString()}));
  console.log(`会议搭子已启动：${app.url}\nVexa：${app.url}/vexa\nCodex：${codexPath ? '已找到，需事先登录' : '未安装；仍可使用 MOSS 交流和 Vexa 转写'}`);
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>app.close().then(()=>process.exit(0)));
  return app;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await boot();
