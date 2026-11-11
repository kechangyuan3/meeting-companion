import {createServer} from 'node:http';
import app from '../dist/server/index.js';
const server=createServer(async(req,res)=>{try{const body=req.method==='GET'||req.method==='HEAD'?undefined:await new Promise((resolve,reject)=>{let value='';req.on('data',chunk=>value+=chunk);req.on('end',()=>resolve(value));req.on('error',reject);});const request=new Request(`http://127.0.0.1:17864${req.url}`,{method:req.method,headers:req.headers,...(body?{body}:{})});const response=await app.fetch(request);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}catch{res.writeHead(500);res.end('Preview request failed');}});
server.listen(17864,'127.0.0.1',()=>console.log('真实在线版页面预览：http://127.0.0.1:17864/（WebSocket 在部署后验证）'));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close(()=>process.exit(0)));
