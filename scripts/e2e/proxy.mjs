// Test infrastructure only. No application API or WebRTC behavior is mocked.
// CI maps the production hostnames to this loopback-only TLS server.
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import { readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { resolve, extname, sep, join } from 'node:path';
const dir = process.argv[2];
if (!dir) throw new Error('TLS directory is required');
const source = readFileSync('src/main.tsx','utf8');
const cloud = source.match(/const CONVEX_URL = "(https:\/\/[^"\s]+)";/)?.[1];
if (cloud !== 'https://precise-ptarmigan-412.eu-west-1.convex.cloud') throw new Error('Review changed backend before running isolation test');
const cloudHost = new URL(cloud).hostname;
const siteHost = cloudHost.replace('.convex.cloud','.convex.site');
const routes = new Map([[cloudHost,3210],[siteHost,3211],['garma-ci-media.test',7880]]);
const counts = { frontend:0, backend:0, upload:0, media:0, upgrades:0, rejectedHosts:0 };
const root = resolve('dist');
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8',
 '.json':'application/json','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png'};
const persist = () => writeFileSync(join(dir,'proxy-counts.json'), JSON.stringify(counts));
const server = https.createServer({key:readFileSync(join(dir,'key.pem')),cert:readFileSync(join(dir,'cert.pem'))}, (req,res)=>{
  const host = (req.headers.host ?? '').split(':')[0];
  const port = routes.get(host);
  if (port) {
    counts[port === 3210 ? 'backend' : port === 3211 ? 'upload' : 'media']++;
    const upstream=http.request({host:'127.0.0.1',port,path:req.url,method:req.method,headers:{...req.headers,'x-forwarded-proto':'https'}}, response=>{
      res.writeHead(response.statusCode ?? 502,response.headers);response.pipe(res);
    });
    upstream.on('error',()=>{ if (!res.headersSent) res.writeHead(502);res.end(); });
    req.on('aborted',()=>upstream.destroy());req.pipe(upstream);persist();return;
  }
  if(host !== 'garma-ci.test') { counts.rejectedHosts++;persist();res.writeHead(403);res.end();return; }
  counts.frontend++;persist();
  let pathname;
  try { pathname=decodeURIComponent(new URL(req.url,'https://garma-ci.test').pathname); }
  catch { res.writeHead(400);res.end();return; }
  let file=resolve(root,'.'+pathname);
  if(file!==root && !file.startsWith(root+sep)) { res.writeHead(403);res.end();return; }
  if(!existsSync(file)||statSync(file).isDirectory()) file=join(root,'index.html');
  const headers = {'Content-Type':mime[extname(file)]??'application/octet-stream','Cache-Control':'no-cache'};
  // Apply the committed hosting headers, including their wildcard sections.
  let applies=false;
  for(const line of readFileSync(join(root,'_headers'),'utf8').split('\n')) {
    if(!line.trim()||line.startsWith('#')) continue;
    if(!/^\s/.test(line)) { const pattern=line.trim();applies=pattern.endsWith('*') ? pathname.startsWith(pattern.slice(0,-1)) : pathname===pattern; }
    else if(applies) { const parts=line.trim().match(/^([^:]+):\s*(.*)$/);if(parts) headers[parts[1]]=parts[2]; }
  }
  // Disposable backend storage URLs use its standard HTTP loopback origin.
  // Permit only that test origin for media in this test host; never modify the
  // production _headers artifact or disable the browser's CSP enforcement.
  const csp = headers['Content-Security-Policy'];
  if (csp) headers['Content-Security-Policy'] = csp.replace(/\b(img-src|media-src)\s/g, '$1 http://127.0.0.1:3210 ');
  res.writeHead(200,headers);res.end(readFileSync(file));
});
server.on('upgrade',(req,socket,head)=>{
  const host=(req.headers.host??'').split(':')[0],port=routes.get(host);
  if(!port) { socket.destroy();return; }
  counts.upgrades++;persist();
  const upstream=net.connect(port,'127.0.0.1',()=>{
    upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
    for(let i=0;i<req.rawHeaders.length;i+=2) upstream.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i+1]}\r\n`);
    upstream.write('X-Forwarded-Proto: https\r\n\r\n');if(head.length) upstream.write(head);
    socket.pipe(upstream);upstream.pipe(socket);
  });
  upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());
  socket.on('close',()=>upstream.destroy());upstream.on('close',()=>socket.destroy());
});
server.listen(443,'127.0.0.1',()=>console.log('Isolated TLS proxy ready on loopback:443'));
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{persist();server.close();process.exit(0);});
