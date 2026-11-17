import {mkdir,readFile,writeFile,readdir,unlink} from 'node:fs/promises';
import {dirname,join,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const manifest=JSON.parse(await readFile(join(root,'.openai/hosting.json'),'utf8'));
if(!manifest.project_id||manifest.static)throw Error('Worker manifest requires an existing project_id and no static field.');
const assets={};
async function collect(directory,prefix){for(const entry of await readdir(directory,{withFileTypes:true})){if(entry.name.startsWith('.'))continue;const path=join(directory,entry.name);const name=`${prefix}/${entry.name}`;if(entry.isDirectory())await collect(path,name);else if(['.html','.css','.js'].includes(extname(entry.name)))assets[name]={type:{'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8'}[extname(entry.name)],text:await readFile(path,'utf8')};}}
await collect(join(root,'cloud/public'),'');await collect(join(root,'demo'),'/demo');
let protocol=await readFile(join(root,'runtime/public-api.mjs'),'utf8');
protocol=protocol.replace(/^import fields[^\n]*\n/,'').replace(/^export /gm,'');
const fields=await readFile(join(root,'runtime/public-fields.json'),'utf8');
const shared=(await readFile(join(root,'vexa-shared.mjs'),'utf8')).replace(/^export /gm,'');
const recap=(await readFile(join(root,'runtime/moss-recap.mjs'),'utf8')).replace(/^export /gm,'');
const xf=(await readFile(join(root,'runtime/xf-live.mjs'),'utf8')).replace(/^export /gm,'');
const worker=(await readFile(join(root,'worker/index.js'),'utf8')).replace(/^import [^\n]*\n/gm,'');
const origin=process.env.SITE_ORIGIN || 'https://meeting-companion-kechangyuan3.happymorel8.chatgpt.site';
const bundle=`const WORKER_ASSETS=${JSON.stringify(assets)};\nconst SITE_ORIGIN=${JSON.stringify(origin)};\n${shared}\n${recap}\n${xf}\nconst {validateRequest,filterEvent}=(()=>{const fields=${fields};\n${protocol}\nreturn {validateRequest,filterEvent};})();\n${worker}`;
await mkdir(join(root,'dist/server'),{recursive:true});await mkdir(join(root,'dist/.openai'),{recursive:true});
await writeFile(join(root,'dist/server/index.js'),bundle);await writeFile(join(root,'dist/.openai/hosting.json'),JSON.stringify(manifest,null,2)+'\n');
// Remove only the known obsolete static output files; preserve the source demo/.
for(const name of ['index.html','vexa.html','style.css','vexa.css','demo-moss.js','demo-vexa.js','.nojekyll'])await unlink(join(root,'dist',name)).catch(error=>{if(error.code!=='ENOENT')throw error;});
console.log(JSON.stringify({worker:join(root,'dist/server/index.js'),assets:Object.keys(assets).length,bytes:Buffer.byteLength(bundle)}));

