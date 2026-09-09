import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,randomUUID,scryptSync,timingSafeEqual} from 'node:crypto';
import {isIP} from 'node:net';
import {Resolver} from 'node:dns/promises';
import {Store} from './store.mjs';
import {Engine,atomic} from './engine.mjs';
import {VERSION,digest,compileCatalog} from './model.mjs';
const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function createApp(options={}){
 process.umask(0o077);
 const data=path.resolve(options.data||process.env.GUI_DATA||'/data/manager');fs.mkdirSync(data,{recursive:true});
 const origin=options.origin||process.env.GUI_PUBLIC_ORIGIN||'http://localhost:20722';const originUrl=new URL(origin);if(!['http:','https:'].includes(originUrl.protocol)||originUrl.username||originUrl.password)throw Error('Invalid public origin');
 const addresses=(options.addresses||process.env.GUI_CACHE_IP||'').split(/[ ,]+/).filter(Boolean);if(addresses.some(x=>!isIP(x)))throw Error('GUI_CACHE_IP must contain cache IP addresses');
 const store=new Store(data,options.cache||process.env.GUI_CACHE_ROOT||'/data/cache/cache',options.logs||process.env.GUI_LOG_ROOT||'/data/logs');
 const engine=options.engine||new Engine({data,enabled:process.env.GUI_MANAGED==='true',addresses});
 let auth=store.get('auth');
 if(!auth){
  const password=options.password||process.env.GUI_INITIAL_PASSWORD;
  auth={enabled:!!password,mustChange:!!password};
  if(password){auth.salt=randomBytes(16).toString('hex');auth.hash=scryptSync(password,auth.salt,64).toString('hex');}
  store.set('auth',auth);
 }
 // Preserve password protection for data created before the optional-login setting.
 if(auth.enabled===undefined){auth.enabled=true;store.set('auth',auth);}

 let integration=store.get('integration')||{enabled:false,instanceId:randomUUID(),tokenHash:null};store.set('integration',integration);
 const registryPath=path.join(base,'vendor/cache-domains');const registry=JSON.parse(fs.readFileSync(path.join(registryPath,'cache_domains.json'),'utf8'));const services=compileCatalog(registry,f=>fs.readFileSync(path.join(registryPath,f),'utf8'));const revision=digest(JSON.stringify(services));
 const resolveDns=options.resolveDns||(async(server,domain,family)=>{const resolver=new Resolver({timeout:2500,tries:1});resolver.setServers([server]);try{return family===6?await resolver.resolve6(domain):await resolver.resolve4(domain);}finally{resolver.cancel();}});
 const sessions=new Map(),limits=new Map(),streams=new Set();let lastNetwork=null,telemetry={sampledAt:Date.now(),engine:{healthy:false,reason:'Checking engine'},network:null};let metricsBusy=false;let summaryCache=null,summaryAt=0;
 function audit(type,detail){const id=store.job(type);store.progress(id,'complete',detail);}
 function session(req){if(!auth.enabled)return {expires:Infinity};const key=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('lc_session='))?.slice(11);const s=sessions.get(key);return s&&s.expires>Date.now()?s:null;}
 function equal(a,b){try{const x=Buffer.from(a,'hex'),y=Buffer.from(b,'hex');return x.length===y.length&&timingSafeEqual(x,y);}catch{return false;}}
 async function body(req){let size=0;const buffers=[];for await(const b of req){size+=b.length;if(size>8*1024*1024)throw Error('Request exceeds 8 MB');buffers.push(b);}try{return JSON.parse(Buffer.concat(buffers).toString()||'{}');}catch{throw Error('Invalid JSON');}}
 function json(res,status,value,headers={}){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store',...headers});res.end(JSON.stringify(value));}
 function snapshot(){if(Date.now()-summaryAt>5000||!summaryCache){summaryCache=store.summary();summaryAt=Date.now();}return {...summaryCache,...telemetry,version:VERSION,settings:engine.state(),metadata:store.get('steamMetadata'),integration:{enabled:integration.enabled,paired:!!integration.tokenHash},passwordRequired:auth.enabled,standalone:true};}
 async function metrics(){if(metricsBusy)return;metricsBusy=true;try{const health=await engine.status();let network=null;try{const lines=fs.readFileSync('/proc/net/dev','utf8').split('\n').filter(x=>/^\s*(eth|en)/.test(x));let rx=0,tx=0;for(const line of lines){const n=line.split(':')[1].trim().split(/\s+/).map(Number);rx+=n[0];tx+=n[8];}const now=Date.now();if(lastNetwork&&now>lastNetwork.time)network={receiveBps:Math.max(0,(rx-lastNetwork.rx)*1000/(now-lastNetwork.time)),sendBps:Math.max(0,(tx-lastNetwork.tx)*1000/(now-lastNetwork.time)),label:'Container network traffic (includes upstream and clients)'};lastNetwork={time:now,rx,tx};}catch{}
  telemetry={sampledAt:Date.now(),engine:health,network};if(streams.size){const packet=`data: ${JSON.stringify(snapshot())}\n\n`;for(const res of streams){if(!session(res.authRequest)||res.writableLength>1024*1024){res.end();streams.delete(res);}else res.write(packet);}}
 }finally{metricsBusy=false;}}
 const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try{
   const url=new URL(req.url,'http://internal');const route=url.pathname;
   if(route==='/healthz'&&req.method==='GET')return json(res,200,{ok:true,product:'lancache',version:VERSION,standalone:true});
   // Host allowlist protects an authenticated LAN GUI against DNS rebinding.
   if(req.headers.host!==originUrl.host&&!options.allowHostMismatch)return json(res,403,{error:'Open the configured management address',code:'ORIGIN_MISMATCH'});
   if(!['GET','HEAD'].includes(req.method)){
    if(req.headers['x-lancache-request']!=='1'||(req.headers.origin&&req.headers.origin!==originUrl.origin))return json(res,403,{error:'Cross-origin write refused',code:'CSRF_REJECTED'});
    if(!(req.headers['content-type']||'').startsWith('application/json'))return json(res,415,{error:'JSON required'});
   }
   if(route==='/api/login'&&req.method==='POST'){
    if(!auth.enabled)return json(res,200,{ok:true,mustChange:false,passwordRequired:false});
    const ip=req.socket.remoteAddress;let limit=limits.get(ip);if(!limit||limit.until<Date.now())limit={count:0,until:Date.now()+900000};if(limit.count>=10)return json(res,429,{error:'Too many login attempts. Try again in 15 minutes.'});limit.count++;limits.set(ip,limit);
    const b=await body(req);if(typeof b.password!=='string'||b.password.length>512||!equal(scryptSync(b.password,auth.salt,64).toString('hex'),auth.hash))return json(res,401,{error:'Incorrect password'});
    limits.delete(ip);const token=randomBytes(32).toString('hex');sessions.set(token,{expires:Date.now()+86400000});return json(res,200,{ok:true,mustChange:auth.mustChange},{'Set-Cookie':`lc_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${originUrl.protocol==='https:'?'; Secure':''}`});
   }
   if(route.startsWith('/api/integrations/v1/')){
    const supplied=req.headers.authorization?.replace(/^Bearer /,'')||'';if(!integration.enabled||!integration.tokenHash||!equal(digest(supplied),integration.tokenHash))return json(res,401,{error:'Integration disabled or invalid token',code:'NOT_PAIRED'});
    if(req.method!=='GET')return json(res,405,{error:'Read-only integration'});
    if(route==='/api/integrations/v1/identity')return json(res,200,{apiVersion:1,product:'lancache',version:VERSION,instanceId:integration.instanceId,capabilities:['status.read','services.read'],standalone:true});
    if(route==='/api/integrations/v1/status')return json(res,200,{apiVersion:1,instanceId:integration.instanceId,engine:telemetry.engine,sampledAt:new Date(telemetry.sampledAt).toISOString(),contentAddresses:{ipv4:addresses.filter(a=>isIP(a)===4),ipv6:addresses.filter(a=>isIP(a)===6)},managementUrl:origin});
    if(route==='/api/integrations/v1/services')return json(res,200,{apiVersion:1,instanceId:integration.instanceId,revision,services:services.map(s=>({id:s.id,name:s.description,domains:s.rules}))});
    return json(res,404,{error:'Unknown integration endpoint'});
   }
   if(route.startsWith('/api/')){
    if(!session(req))return json(res,401,{error:'Sign in required',code:'AUTH_REQUIRED'});
    if(route==='/api/session')return json(res,200,{authenticated:true,mustChange:auth.mustChange,passwordRequired:auth.enabled});
    if(route==='/api/logout'&&req.method==='POST'){const raw=req.headers.cookie?.match(/lc_session=([a-f0-9]+)/)?.[1];sessions.delete(raw);return json(res,200,{ok:true},{'Set-Cookie':'lc_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});}
    if(route==='/api/events'&&req.method==='GET'){
     if(streams.size>=20)return json(res,429,{error:'Too many live connections'});res.authRequest=req;res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});res.write(`data: ${JSON.stringify(snapshot())}\n\n`);streams.add(res);const expiry=setTimeout(()=>res.end(),3600000);req.on('close',()=>{clearTimeout(expiry);streams.delete(res);});return;
    }
    if(route==='/api/overview'&&req.method==='GET')return json(res,200,snapshot());
    if(route==='/api/library'&&req.method==='GET')return json(res,200,store.library(Object.fromEntries(url.searchParams)));
    if(route==='/api/versions'&&req.method==='GET')return json(res,200,{versions:store.versions()});
    if(route==='/api/services'&&req.method==='GET')return json(res,200,{revision,services,addresses,standalone:true});
    if(route==='/api/settings'&&req.method==='GET')return json(res,200,{...engine.state(),passwordRequired:auth.enabled});
    if(route==='/api/integration'&&req.method==='GET')return json(res,200,{enabled:integration.enabled,instanceId:integration.instanceId,hasToken:!!integration.tokenHash,managementUrl:origin});
    if(req.method!=='POST')return json(res,404,{error:'Endpoint not found'});
    const b=await body(req);
    if(route==='/api/password'){
     if(b.enabled===false){auth={enabled:false,mustChange:false};store.set('auth',auth);sessions.clear();audit('Password protection',{enabled:false});try{fs.unlinkSync(path.join(data,'initial-login.txt'));}catch{}return json(res,200,{ok:true,passwordRequired:false});}
     if(typeof b.password!=='string'||b.password.length<12||b.password.length>200)throw Error('Use a password between 12 and 200 characters');auth={enabled:true,salt:randomBytes(16).toString('hex'),mustChange:false};auth.hash=scryptSync(b.password,auth.salt,64).toString('hex');store.set('auth',auth);sessions.clear();audit('Password protection',{enabled:true});try{fs.unlinkSync(path.join(data,'initial-login.txt'));}catch{}return json(res,200,{ok:true,signInAgain:true});}
    if(route==='/api/index'){if(store.scanning||store.mutating)throw Error('Indexing or cleanup is already running');void store.scan();return json(res,202,{ok:true});}
    if(route==='/api/library/name'){store.rename(b.id,b.title);summaryAt=0;return json(res,200,{ok:true});}
    if(route==='/api/clients/name'){const result=store.setClientAlias(b.client,b.name);summaryAt=0;audit('Device name',result);return json(res,200,result);}
    if(route==='/api/cleanup/preview')return json(res,200,store.plan(b.ids,{mode:b.mode,days:Math.max(0,Number(b.days)||0)}));
    if(route==='/api/cleanup/execute'){if(b.confirmation!=='DELETE')throw Error('Type DELETE to confirm the preview');const result=await store.execute(b.planId,engine);summaryAt=0;return json(res,202,result);}
    if(route==='/api/manifests/import'){const result=store.importManifests(b);audit('Manifest import',result);return json(res,200,result);}
    if(route==='/api/settings/apply'){
     const job=store.job('Engine settings',{revision:b.revision});try{const state=await engine.apply(b.values,b.revision);store.progress(job,'complete',{revision:state.revision,values:state.values});return json(res,200,state);}catch(e){store.progress(job,'failed',{error:e.message});throw e;}
    }
    if(route==='/api/metadata/steam'){if(store.jobs().some(j=>j.type==='Steam metadata'&&j.state==='running'))throw Error('Metadata refresh already running');void store.refreshSteam().catch(()=>{});return json(res,202,{ok:true});}
    if(route==='/api/integration'){
     if(typeof b.enabled!=='boolean')throw Error('Enabled must be true or false');integration.enabled=b.enabled;let token;
     if(b.enabled&&(b.rotate||!integration.tokenHash)){token=randomBytes(32).toString('base64url');integration.tokenHash=digest(token);}if(!b.enabled)integration.tokenHash=null;store.set('integration',integration);audit('Optional integration',{enabled:b.enabled,tokenRotated:!!token});return json(res,200,{enabled:integration.enabled,instanceId:integration.instanceId,token});
    }
    if(route==='/api/dns/export'){
     if(!isIP(b.address)||!Array.isArray(b.services)||b.services.length>services.length)throw Error('Choose a cache IP and services');const selected=services.filter(s=>b.services.includes(s.id));
     const rules=new Map();for(const s of selected)for(const r of s.rules)rules.set(`${r.type}:${r.domain}`,r);
     const text=['# LanCache GUI generated dnsmasq configuration','# Review before installing in your independently managed DNS server.',...Array.from(rules.values()).flatMap(r=>r.type==='exact'?[`host-record=${r.domain},${b.address}`]:[`address=/*.${r.domain}/${b.address}`,`local=/*.${r.domain}/`])].join('\n')+'\n';
     return json(res,200,{filename:'lancache-dnsmasq.conf',content:text,revision,note:'Validate exact/wildcard semantics with your dnsmasq version. No DNS server was changed.'});
    }
    if(route==='/api/dns/validate'){
     if(!isIP(b.address)||!isIP(b.dnsServer)||!Array.isArray(b.services)||b.services.length<1||b.services.length>services.length)throw Error('Choose a cache IP, DNS resolver IP, and at least one service');
     const selected=services.filter(s=>b.services.includes(s.id));if(selected.length!==new Set(b.services).size)throw Error('One or more selected services are unknown');
     const family=isIP(b.address),targets=selected.map(s=>{const rule=s.rules.find(r=>r.type==='exact')||s.rules[0];return {id:s.id,name:s.description,domain:rule?.type==='wildcard'?`lancache-test.${rule.domain}`:rule?.domain,originDomain:rule?.type==='wildcard'?`www.${rule.domain}`:rule?.domain};}).filter(x=>x.domain);
     const routeResults=await Promise.all(targets.map(async target=>{try{const answers=await resolveDns(b.dnsServer,target.domain,family);return {...target,answers,ok:answers.includes(b.address)};}catch(e){return {...target,answers:[],ok:false,error:e.code||e.message};}}));
     const reachable=routeResults.some(r=>r.answers.length);const routed=routeResults.filter(r=>r.ok).length;
     const state=engine.state(),originServer=state.values?.UPSTREAM_DNS?.split(/[ ;]+/).map(x=>x.replace(/^\[|\]$/g,'')).find(isIP);let origin={ok:false,answers:[],server:originServer||'',error:''};
     if(originServer&&targets[0])try{origin.answers=await resolveDns(originServer,targets[0].originDomain,family);origin.ok=origin.answers.length>0&&!origin.answers.includes(b.address);}catch(e){origin.error=e.code||e.message;}
     const observed=new Set(store.activity().sessions.map(s=>s.service));const observedNames=selected.filter(s=>observed.has(s.id)).map(s=>s.description);
     const checks=[
      {id:'engine',label:'Cache engine',status:telemetry.engine.healthy?'pass':'fail',detail:telemetry.engine.healthy?'The managed cache engine is responding.':telemetry.engine.reason||'The cache engine is not ready.'},
      {id:'resolver',label:'DNS resolver',status:reachable?'pass':'fail',detail:reachable?`${b.dnsServer} answered the selected service checks.`:`${b.dnsServer} did not return an address for the selected services.`},
      {id:'routes',label:'Cache routes',status:routed===targets.length?'pass':routed?'warn':'fail',detail:`${routed} of ${targets.length} selected service domains resolve to ${b.address}.`,services:routeResults},
      {id:'origin',label:'Origin resolver',status:origin.ok?'pass':'warn',detail:origin.ok?`${origin.server} resolves public origin addresses independently.`:'The configured origin resolver could not be confirmed. Cache downloads may fail on misses.',origin},
      {id:'traffic',label:'Recent traffic',status:observedNames.length?'pass':'pending',detail:observedNames.length?`Recent cache traffic: ${observedNames.join(', ')}.`:'No selected-service traffic was seen in the last 30 minutes. Start a download after the route checks pass.'}
     ];
     return json(res,200,{checkedAt:Date.now(),address:b.address,dnsServer:b.dnsServer,checks,ready:checks.slice(0,4).every(c=>['pass','warn'].includes(c.status))&&routed===targets.length,note:'Read-only validation. No DNS settings were changed and no service was restarted.'});
    }
    if(route==='/api/backup'){store.db.exec('PRAGMA wal_checkpoint(PASSIVE)');const payload={version:VERSION,exportedAt:new Date().toISOString(),engine:engine.state(),names:store.db.prepare('SELECT id,custom_title FROM items WHERE custom_title IS NOT NULL').all(),manifests:store.versions(),integration:{enabled:integration.enabled,instanceId:integration.instanceId},jobs:store.jobs()};return json(res,200,payload,{'Content-Disposition':'attachment; filename="lancache-settings-export.json"'});}
    return json(res,404,{error:'Endpoint not found'});
   }
   if(req.method!=='GET'&&req.method!=='HEAD')return json(res,405,{error:'Method not allowed'});
   const assets={'/':'index.html','/app.js':'app.js','/style.css':'style.css','/favicon.svg':'favicon.svg'};const file=assets[route];if(!file)return json(res,404,{error:'Not found'});
   const type=file.endsWith('.html')?'text/html':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'image/svg+xml';res.writeHead(200,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-cache'});if(req.method==='HEAD')res.end();else fs.createReadStream(path.join(base,'public',file)).pipe(res);
  }catch(e){if(!res.headersSent)json(res,400,{error:e.message});else res.end();}
 });
 server.requestTimeout=30000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
 const timers=[];
 function startWorkers(){timers.push(setInterval(()=>void store.ingest(),250),setInterval(()=>void metrics(),2000),setInterval(()=>{const age=Date.now()-(store.scanState.completedAt||Date.now());if(!store.scanning&&!store.mutating&&!engine.busy&&store.logState.caughtUp&&age>30000&&(store.inventoryDirty||age>1800000)){store.inventoryDirty=false;void store.scan();}},10000),setInterval(()=>{for(const[k,v]of sessions)if(v.expires<Date.now())sessions.delete(k);for(const[k,v]of limits)if(v.until<Date.now())limits.delete(k);},60000));void metrics();void store.scan();}
 async function stop(){timers.forEach(clearInterval);for(const res of streams)res.end();store.closed=true;while(store.scanning||store.logBusy)await new Promise(r=>setTimeout(r,20));await new Promise(r=>server.close(r));store.close();}
 return {server,store,engine,startWorkers,stop};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 if(process.argv.includes('--configure')){new Engine({data:process.env.GUI_DATA||'/data/manager',enabled:true,addresses:(process.env.GUI_CACHE_IP||'').split(/[ ,]+/).filter(Boolean)}).bootstrap();}
 else{const app=createApp();const port=Number(process.env.GUI_PORT||20722);app.server.listen(port,process.env.GUI_BIND||'0.0.0.0',()=>{console.log(`LanCache GUI ${VERSION} listening on port ${port}; standalone mode`);app.startWorkers();});for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void app.stop().then(()=>process.exit(0)));}
}
