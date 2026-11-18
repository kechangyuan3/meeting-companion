import {mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join,extname,dirname} from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
export async function buildPages({out=join(root,'pages-dist'),backend='https://meeting-companion-kechangyuan3.happymorel8.chatgpt.site'}={}){
  const url=new URL(backend);
  if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('Pages backend must be an HTTPS origin.');
  const files=[];
  async function collect(directory,prefix=''){
    for(const entry of await readdir(directory,{withFileTypes:true})){
      if(entry.name.startsWith('.'))continue;
      const source=join(directory,entry.name),relative=prefix+entry.name;
      if(entry.isDirectory()){await collect(source,relative+'/');continue;}
      if(!['.html','.css','.js'].includes(extname(entry.name)))continue;
      let text=await readFile(source,'utf8');
      if(extname(entry.name)==='.html'&&!prefix.startsWith('demo/')){
        text=text.replaceAll('href="/style.css"','href="./style.css"').replaceAll('href="/vexa.css"','href="./vexa.css"').replaceAll('href="/demo/"','href="./demo/"').replaceAll('href="/vexa"','href="./vexa.html"').replaceAll('href="/"','href="./"').replaceAll('src="/app.js"','src="./app.js"').replaceAll('src="/vexa.js"','src="./vexa.js"');
        text=text.replace('在线版 · 每人使用自己的 Key','GitHub Pages · 每人使用自己的 Key').replace('公开在线版 ·','GitHub Pages ·');
        const policy=`default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ${url.origin} ${url.origin.replace(/^http/,'ws')}; media-src 'self' blob:; worker-src 'self'; base-uri 'none'; form-action 'none'`;
        text=text.replace('</head>',`<meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"></head>`);
      }
      const target=join(out,relative);await mkdir(dirname(target),{recursive:true});await writeFile(target,text);files.push(relative);
    }
  }
  await collect(join(root,'cloud/public'));await collect(join(root,'demo'),'demo/');
  await writeFile(join(out,'service-config.js'),`// Public backend address; no credentials.\nexport const BACKEND_ORIGIN = ${JSON.stringify(url.origin)};\n`);
  await writeFile(join(out,'.nojekyll'),'');
  return {out,backend:url.origin,files:files.length};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1])console.log(JSON.stringify(await buildPages({backend:process.env.MEETING_BACKEND_ORIGIN||undefined})));
