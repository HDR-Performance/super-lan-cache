import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DEFAULTS,validateSettings,settingsInput} from './model.mjs';
const run=promisify(execFile);
export function atomic(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.tmp';fs.writeFileSync(tmp,value,{mode:0o600});fs.renameSync(tmp,file);}
export class Engine{
 constructor({data,root='/etc/nginx',templates='/opt/lancache-gui/vendor/monolithic/overlay/etc/nginx',enabled=false,addresses=[],env=process.env,command=run}){
  this.data=data;this.root=root;this.templates=templates;this.enabled=enabled;this.addresses=addresses;this.command=command;this.restartRequired=false;
  this.defaults=Object.fromEntries(Object.entries(DEFAULTS).map(([k,v])=>[k,env[k]||v]));this.file=path.join(data,'engine-settings.json');
  this.saved=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):{revision:0,values:this.defaults};
  this.saved.values=validateSettings(settingsInput(this.saved.values),addresses);this.busy=false;
 }
 state(){return {...this.saved,defaults:this.defaults,managed:this.enabled,sliceSize:'1m',configurationAuthority:'Persistent GUI overrides, applied at startup and after each validated change'};}
 render(values){
  const files=['conf.d/20_proxy_cache_path.conf','sites-available/cache.conf.d/root/20_cache.conf','sites-available/cache.conf.d/10_root.conf','sites-available/upstream.conf.d/10_resolver.conf','stream-available/10_sni.conf'];
  return Object.fromEntries([...files.map(f=>{let text=fs.readFileSync(path.join(this.templates,f),'utf8');for(const [k,v]of Object.entries(values))text=text.replaceAll(k,v);return [path.join(this.root,f),text];}),[path.join(this.root,'workers.conf'),`worker_processes ${values.NGINX_WORKER_PROCESSES};\n`]]);
 }
 bootstrap(){const hash='/data/cache/CONFIGHASH';if(fs.existsSync(hash)&&!fs.readFileSync(hash,'utf8').includes('CACHE_SLICE_SIZE=1m;'))throw Error('Unsupported existing cache slice size; preserved without changes');for(const [file,text]of Object.entries(this.render(this.saved.values))){fs.writeFileSync(file,text);}if(!fs.existsSync(this.file))atomic(this.file,JSON.stringify(this.saved));}
 async status(){
  if(!this.enabled)return {healthy:false,mode:'development',reason:'Engine controls are unavailable outside the managed container'};
  try{const r=await fetch('http://127.0.0.1/lancache-heartbeat',{signal:AbortSignal.timeout(2500)});const s=await fetch('http://127.0.0.1:8080/nginx_status',{signal:AbortSignal.timeout(2500)}).then(x=>x.text());const m=s.match(/Active connections:\s*(\d+)[\s\S]*?Reading:\s*(\d+) Writing:\s*(\d+) Waiting:\s*(\d+)/);return {healthy:r.status===204,mode:'managed',connections:m?{active:+m[1],reading:+m[2],writing:Math.max(0,+m[3]-1),waiting:+m[4]}:null};}catch(e){return {healthy:false,mode:'managed',reason:e.message};}
 }
 async stop(){if(!this.enabled)throw Error('Engine control unavailable');const s=await this.status();if(!s.healthy||!s.connections)throw Error('Cannot establish engine activity; maintenance refused');if(s.connections.reading+s.connections.writing>0)throw Error('Downloads are active; retry when idle');this.restartRequired=true;await this.command('supervisorctl',['-c','/etc/supervisor/gui-control.conf','stop','nginx'],{timeout:100000});
  const procs=fs.readdirSync('/proc').filter(x=>/^\d+$/.test(x));if(procs.some(p=>{try{return fs.readFileSync(`/proc/${p}/comm`,'utf8').trim()==='nginx';}catch{return false;}}))throw Error('NGINX has not fully stopped; maintenance refused');
 }
 async start(){if((await this.status()).healthy){this.restartRequired=false;return;}await this.command('supervisorctl',['-c','/etc/supervisor/gui-control.conf','start','nginx'],{timeout:15000});for(let i=0;i<20;i++){if((await this.status()).healthy){this.restartRequired=false;return;}await new Promise(r=>setTimeout(r,500));}throw Error('NGINX did not become healthy');}
 async apply(input,revision){
  if(!this.enabled)throw Error('Engine controls are available in the managed container only');if(this.busy)throw Error('Another maintenance job is running');if(revision!==this.saved.revision)throw Error('Settings changed. Reload before applying.');
  const values=validateSettings(input,this.addresses);const generated=this.render(values),previous=Object.fromEntries(Object.keys(generated).map(f=>[f,fs.readFileSync(f,'utf8')]));this.busy=true;let stopped=false;
  try{
   for(const[f,t]of Object.entries(generated))fs.writeFileSync(f,t);
   await this.command('nginx',['-t'],{timeout:15000});
   // Stop only after configuration validates; old workers still use their original settings.
   await this.stop();stopped=true;
   const next={revision:this.saved.revision+1,values,appliedAt:new Date().toISOString()};
   atomic(this.file+'.previous',JSON.stringify(this.saved));atomic(this.file,JSON.stringify(next));
   await this.start();stopped=false;this.saved=next;return this.state();
  }catch(e){for(const[f,t]of Object.entries(previous))fs.writeFileSync(f,t);atomic(this.file,JSON.stringify(this.saved));if(stopped||this.restartRequired)try{await this.start();}catch(recovery){throw Error(`${e.message}; rollback restart failed: ${recovery.message}`);}throw e;
  }finally{this.busy=false;}
 }
}
