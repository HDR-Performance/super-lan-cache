import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import http from 'node:http';
const image=process.argv[2]||'super-lan-cache:ci';
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8'}).trim();
const pause=()=>new Promise(r=>setTimeout(r,1000));
const base='http://127.0.0.1:20722';
async function api(route,data){const r=await fetch(base+'/api/'+route,{method:data?'POST':'GET',headers:{Origin:base,'Content-Type':'application/json','X-LanCache-Request':'1'},body:data?JSON.stringify(data):undefined});assert.equal(r.status,200,await r.clone().text());return r.json();}
try{
 docker('network','create','slc-ci');
 docker('run','-d','--name','slc-origin','--network','slc-ci','--entrypoint','node','-v',resolve('deploy/origin-fixture.mjs')+':/origin.mjs:ro',image,'/origin.mjs');
 const origin=docker('inspect','slc-origin','--format','{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}');
 docker('run','-d','--name','slc-cache','--network','slc-ci','-p','127.0.0.1:18080:80','-p','127.0.0.1:20722:20722','-e','GUI_PUBLIC_ORIGIN='+base,'-e','GUI_CACHE_IP=127.0.0.1','-e','CACHE_DISK_SIZE=2g','-e','CACHE_INDEX_SIZE=10m','-e','MIN_FREE_DISK=1g',image);
 let healthy=false;
 for(let n=0;n<120;n++){try{const r=await fetch(base+'/api/overview');if(r.ok&&(await r.json()).engine.healthy){healthy=true;break;}}catch{}await pause();}
 assert.ok(healthy,'Cache and GUI must become healthy');
 assert.equal((await api('session')).passwordRequired,false);
 assert.match(await (await fetch(base)).text(),/Super Lan-Cache/);
 assert.equal((await fetch(base+'/favicon.svg')).status,200);
 // Use an explicit HTTP Host header. fetch normalizes Host to the URL authority.
 const request=()=>new Promise((resolve,reject)=>{
  const req=http.get('http://127.0.0.1:18080/depot/999999001/chunk/release-test',{headers:{Host:origin,'User-Agent':'Valve/Steam HTTP Client 1.0'}},res=>{
   const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks)}));res.on('error',reject);
  });req.setTimeout(30000,()=>req.destroy(Error('Origin timeout')));req.on('error',reject);
 });
 for(let n=0;n<2;n++){const r=await request();assert.equal(r.status,200);const b=r.body;assert.equal(b.length,3145728);assert.ok(b.every(v=>v===71));await pause();}
 assert.match(docker('exec','slc-cache','cat','/data/logs/access.log'),/"HIT"/);
 await api('index',{});
 let library;
 for(let n=0;n<60;n++){library=await api('library');if(library.rows.some(x=>x.product==='depot:999999001'&&x.resident_bytes>0))break;await pause();}
 assert.ok(library.rows.some(x=>x.product==='depot:999999001'&&x.resident_bytes>0),'Real files must appear in the inventory');
 console.log('PASS: integrated engine, no-login default, web assets, real MISS/HIT transfer and existing-file indexing');
}finally{
 for(const name of ['slc-cache','slc-origin']){try{console.log(docker('logs','--tail','30',name));}catch{}try{docker('rm','-fv',name);}catch{}}
 try{docker('network','rm','slc-ci');}catch{}
}
