import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join, extname} from 'node:path';
const root=fileURLToPath(new URL('../demo/',import.meta.url));
const files=new Set(['index.html','vexa.html','style.css','vexa.css','demo-moss.js','demo-vexa.js']);
const server=createServer(async(req,res)=>{const path=new URL(req.url,'http://127.0.0.1').pathname;const name=path==='/'?'index.html':path.slice(1);if(!files.has(name)){res.writeHead(404);return res.end('Not found');}try{const data=await readFile(join(root,name));res.writeHead(200,{'Content-Type':{'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8'}[extname(name)],'Cache-Control':'no-store'});res.end(data);}catch{res.writeHead(500);res.end('Cannot read preview assets');}});
server.listen(17863,'127.0.0.1',()=>console.log('演示预览：http://127.0.0.1:17863/'));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close(()=>process.exit(0)));
