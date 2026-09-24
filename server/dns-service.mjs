import fs from 'node:fs';
import path from 'node:path';
import {isIP} from 'node:net';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {atomic} from './engine.mjs';
import {compileCatalog,digest} from './model.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
export const DNS_CONFIG_FILE='dns-service.json';
export const DNS_STATUS_FILE='dns-status.json';
export const defaultDnsConfig=(services=[],addresses=[])=>({revision:0,enabled:false,listenAddress:addresses.find(x=>isIP(x)===4)||addresses[0]||'',upstreams:['1.1.1.1','1.0.0.1'],selectedServices:services.map(s=>s.id),catalogRevision:null,updatedAt:null});

function unique(values){return [...new Set(values)];}
export function validateDnsConfig(input,services,addresses=[],expectedRevision){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Built-in DNS settings must be an object');
 const known=new Map(services.map(s=>[s.id,s]));
 const current=Number(input.revision);
 if(expectedRevision!==undefined&&current!==expectedRevision)throw Error('Built-in DNS settings changed. Reload and try again.');
 if(typeof input.enabled!=='boolean')throw Error('Choose whether built-in DNS is enabled');
 if(input.enabled&&(!isIP(input.listenAddress)||!addresses.includes(input.listenAddress)))throw Error('DNS must listen on one of this cache server’s configured addresses');
 if(!input.enabled&&input.listenAddress&&(!isIP(input.listenAddress)||!addresses.includes(input.listenAddress)))throw Error('DNS listen address must use one of this cache server’s configured addresses');
 if(!Array.isArray(input.upstreams)||input.upstreams.length<1||input.upstreams.length>4)throw Error('Choose one to four independent upstream DNS servers');
 const upstreams=unique(input.upstreams.map(x=>String(x).trim()));
 if(upstreams.some(ip=>!isIP(ip)||addresses.includes(ip)||ip==='0.0.0.0'||ip==='::'||ip.startsWith('127.')||ip==='::1'))throw Error('Upstream DNS must use valid independent resolver IPs, excluding this cache and loopback');
 if(!Array.isArray(input.selectedServices)||input.selectedServices.length<1||input.selectedServices.length>services.length)throw Error('Select at least one supported cache service');
 const selectedServices=unique(input.selectedServices.map(String));
 if(selectedServices.some(id=>!known.has(id)))throw Error('The service catalog changed. Reload before saving built-in DNS.');
 return {revision:current,enabled:input.enabled,listenAddress:input.listenAddress,upstreams,selectedServices:selectedServices.sort()};
}

export function dnsmasqConfig(config,services,cacheAddresses,port=53){
 if(!Number.isInteger(port)||port<1||port>65535)throw Error('DNS port must be between 1 and 65535');
 const known=new Map(services.map(s=>[s.id,s])),rules=new Map();
 for(const id of config.selectedServices)for(const rule of known.get(id)?.rules||[])rules.set(`${rule.type}:${rule.domain}`,rule);
 const addresses=unique(cacheAddresses.filter(isIP));
 if(!addresses.length)throw Error('At least one cache address is required');
 const lines=['# Super Lan-Cache managed DNS - edit through the web interface',`port=${port}`,`listen-address=${config.listenAddress}`,'bind-dynamic','no-resolv','no-hosts','domain-needed','cache-size=10000','local-ttl=60','neg-ttl=60',...config.upstreams.map(ip=>`server=${ip}`)];
 for(const rule of rules.values()){
  if(rule.type==='exact')lines.push(`host-record=${rule.domain},${addresses.join(',')}`);
  else {lines.push(`local=/${rule.domain}/`);for(const ip of addresses)lines.push(`address=/${rule.domain}/${ip}`);}
 }
 if(lines.length>20020)throw Error('The selected DNS route set exceeds the 20,000-line safety limit');
 return {content:lines.join('\n')+'\n',ruleCount:rules.size,lineCount:lines.length};
}

export function loadCatalog(root=path.resolve(here,'../vendor/cache-domains')){
 const registry=JSON.parse(fs.readFileSync(path.join(root,'cache_domains.json'),'utf8'));
 const services=compileCatalog(registry,file=>fs.readFileSync(path.join(root,file),'utf8'));
 return {services,revision:digest(JSON.stringify(services))};
}

function readJson(file,fallback){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return fallback;}}
function writeJson(file,value){atomic(file,JSON.stringify(value,null,2)+'\n',0o600);}

export class DnsSidecar{
 constructor({data=process.env.GUI_DATA||'/data/manager',addresses=(process.env.GUI_CACHE_IP||'').split(/[ ,]+/).filter(Boolean),port=Number(process.env.GUI_DNS_PORT||53),binary=process.env.DNSMASQ_BIN||'/usr/sbin/dnsmasq',clock=Date.now}={}){
  this.data=path.resolve(data);this.addresses=addresses;this.port=port;this.binary=binary;this.clock=clock;this.child=null;this.timer=null;this.heartbeat=null;this.signature='';this.stopping=false;this.lastStatus=null;fs.mkdirSync(this.data,{recursive:true});
  const catalog=loadCatalog();this.services=catalog.services;this.catalogRevision=catalog.revision;this.configFile=path.join(this.data,DNS_CONFIG_FILE);this.statusFile=path.join(this.data,DNS_STATUS_FILE);this.renderedFile=path.join(this.data,'dnsmasq-managed.conf');
 }
 status(state,detail={}){const value={...detail,state,ready:state==='running',enabled:detail.enabled??state!=='off',port:this.port,pid:this.child?.pid||null,updatedAt:new Date(this.clock()).toISOString()};this.lastStatus=value;writeJson(this.statusFile,value);return value;}
 async stopChild(){const child=this.child;if(!child)return;this.child=null;await new Promise(resolve=>{const done=()=>resolve();child.once('exit',done);child.kill('SIGTERM');setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL');resolve();},3000).unref();});}
 async reconcile(){
  const base=defaultDnsConfig(this.services,this.addresses),raw=readJson(this.configFile,base),signature=digest(JSON.stringify(raw));if(signature===this.signature)return;this.signature=signature;
  await this.stopChild();let config;
  try{config=validateDnsConfig(raw,this.services,this.addresses);if(!config.enabled){this.status('off',{enabled:false,message:'Built-in DNS is disabled.',revision:config.revision});return;}}
  catch(error){this.status('error',{message:error.message,revision:raw?.revision??null});return;}
  let rendered;try{rendered=dnsmasqConfig(config,this.services,this.addresses,this.port);atomic(this.renderedFile,rendered.content,0o600);const tested=spawnSync(this.binary,['--test',`--conf-file=${this.renderedFile}`],{encoding:'utf8',timeout:5000});if(tested.error)throw tested.error;if(tested.status!==0)throw Error((tested.stderr||tested.stdout||'dnsmasq rejected the managed configuration').trim());}
  catch(error){this.status('error',{message:error.message,revision:config.revision});return;}
  this.status('starting',{listenAddress:config.listenAddress,revision:config.revision,serviceCount:config.selectedServices.length,ruleCount:rendered.ruleCount,message:`Starting DNS on ${config.listenAddress}:${this.port}.`});
  const child=spawn(this.binary,['--keep-in-foreground',`--conf-file=${this.renderedFile}`],{stdio:['ignore','ignore','pipe']});this.child=child;let stderr='';
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-4000);});
  child.once('error',error=>{if(this.child===child)this.child=null;this.status('error',{listenAddress:config.listenAddress,revision:config.revision,message:`DNS could not start: ${error.message}`});});
  child.once('exit',code=>{if(this.child!==child||this.stopping)return;this.child=null;const conflict=/address already in use|failed to create listening socket/i.test(stderr);this.status(conflict?'conflict':'error',{listenAddress:config.listenAddress,revision:config.revision,message:conflict?`Port ${this.port} is already used by another DNS service. Leave built-in DNS off or stop the other resolver.`:`DNS stopped unexpectedly (${code??'signal'}). ${stderr.trim()}`.trim()});});
  await new Promise(resolve=>setTimeout(resolve,700));if(this.child===child&&child.exitCode===null)this.status('running',{listenAddress:config.listenAddress,revision:config.revision,serviceCount:config.selectedServices.length,ruleCount:rendered.ruleCount,message:`DNS is answering on ${config.listenAddress}:${this.port}.`});
 }
 start(){this.status('off',{enabled:false,message:'Built-in DNS is disabled.'});void this.reconcile();this.timer=setInterval(()=>void this.reconcile(),1000);this.heartbeat=setInterval(()=>{if(this.child&&this.lastStatus?.state==='running')this.status('running',this.lastStatus);},10000);}
 async stop(){this.stopping=true;clearInterval(this.timer);clearInterval(this.heartbeat);await this.stopChild();this.status('off',{enabled:false,message:'Built-in DNS sidecar stopped.'});}
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
 const sidecar=new DnsSidecar();sidecar.start();const stop=async()=>{await sidecar.stop();process.exit(0);};process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
