import {createHash} from 'node:crypto';
import {isIP} from 'node:net';
export const VERSION='0.1.2';
export const digest=s=>createHash('sha256').update(s).digest('hex');
export const DEFAULTS={CACHE_DISK_SIZE:'1000g',CACHE_INDEX_SIZE:'500m',MIN_FREE_DISK:'10g',CACHE_MAX_AGE:'3560d',UPSTREAM_DNS:'8.8.8.8 8.8.4.4',NGINX_WORKER_PROCESSES:'auto'};
export function validateSettings(input,addresses=[]){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Settings must be an object');
 for(const key of Object.keys(input))if(!(key in DEFAULTS))throw Error(`Unsupported engine setting: ${key}`);
 const result={...DEFAULTS,...input};
 if(Object.values(result).some(v=>typeof v!=='string'))throw Error('Engine settings must be strings');
 for(const k of ['CACHE_DISK_SIZE','MIN_FREE_DISK'])if(!/^[1-9]\d{0,6}g$/.test(result[k]))throw Error(`${k} requires a positive whole number followed by g`);
 if(!/^[1-9]\d{0,5}m$/.test(result.CACHE_INDEX_SIZE)||parseInt(result.CACHE_INDEX_SIZE)>32768)throw Error('Index memory must be 1–32768m');
 if(!/^[1-9]\d{0,4}d$/.test(result.CACHE_MAX_AGE)||parseInt(result.CACHE_MAX_AGE)>36500)throw Error('Retention must be 1–36500d');
 if(!/^(auto|[1-9]\d{0,2})$/.test(result.NGINX_WORKER_PROCESSES))throw Error('Workers must be auto or 1–999');
 if(typeof result.UPSTREAM_DNS!=='string')throw Error('DNS must contain resolver IP addresses');
 const resolvers=result.UPSTREAM_DNS.trim().split(/[ ;]+/);
 if(!resolvers.length||resolvers.length>4||resolvers.some(ip=>!isIP(ip)||addresses.includes(ip)||ip==='0.0.0.0'||ip==='::'||ip.startsWith('127.')||ip==='::1'))throw Error('Use up to four origin resolver IPs, excluding the cache address and loopback');
 result.UPSTREAM_DNS=resolvers.map(ip=>isIP(ip)===6?`[${ip}]`:ip).join(' ');
 return result;
}
export function settingsInput(s){return {...s,UPSTREAM_DNS:s.UPSTREAM_DNS.replace(/[\[\]]/g,'')};}
export function identify(service,uri){
 const path=uri.split('?')[0]; let product,version='Unknown',kind='service';
 const depot=path.match(/\/depot\/(\d+)(?:\/|$)/i);
 if(service==='steam'&&depot){product=`depot:${depot[1]}`;kind='depot';}
 else if(service==='xboxlive'){
  const file=path.split('/').pop(); const p=file.match(/^(.+?)_(\d+(?:\.\d+){1,5})_(.+?)\.(?:xvc|msixvc|appx|msix|eappx)(?:\..*)?$/i);
  if(p){product=p[1];version=p[2];kind='package';}else {product=file?.length>3?file.slice(0,160):'Unresolved Xbox content';kind='artifact';}
 }else if(service==='wsus'){product=path.split('/').pop()?.slice(0,160)||'Unresolved Windows update';kind='artifact';}
 else {const dirs=path.split('/').filter(Boolean);product=dirs[0]||service;kind='unresolved';}
 const id=digest(`${service}\n${product}\n${version}`).slice(0,32);
 return {id,service,product,version,kind,title:kind==='depot'?`Steam depot ${depot[1]}`:product};
}
export function parseKey(buffer,filename){
 const start=buffer.indexOf('\nKEY: ');if(start<0)return null;
 const end=buffer.indexOf('\n',start+6);if(end<0)return null;
 const key=buffer.subarray(start+6,end).toString('utf8');
 if(createHash('md5').update(key).digest('hex')!==filename)return null;
 const match=key.match(/^([^/]+)(\/.*?)(bytes=\d+-\d+)?$/);if(!match)return null;
 return {key,service:match[1],uri:match[2],range:match[3]||'',item:identify(match[1],match[2])};
}
export function parseLog(line){
 let row;
 try{if(line.startsWith('{')){const j=JSON.parse(line);row={time:Number(j.timestamp)*1000,service:j.cache_identifier,client:j.remote_addr,path:j.path,status:Number(j.status),bytes:Number(j.bytes_sent),cache:j.upstream_cache_status,host:j.host};}}
 catch{return null;}
 if(!row){const m=line.match(/^\[([^\]]+)\] (\S+) \/ .*? \[([^\]]+)\] "\S+ (.*?) HTTP\/[^\"]+" (\d+) (\d+) "[^\"]*" "[^\"]*" "([^\"]*)" "([^\"]*)"/);
  if(!m)return null;
  row={service:m[1],client:m[2],time:Date.parse(m[3].replace(/^(\d+)\/(\w+)\/(\d+):/,'$2 $1 $3 ')),path:m[4],status:Number(m[5]),bytes:Number(m[6]),cache:m[7],host:m[8]};
 }
 if(!Number.isFinite(row.time)||!Number.isFinite(row.bytes)||row.bytes<0||typeof row.path!=='string'||typeof row.service!=='string'||row.path==='/lancache-heartbeat')return null;
 row.item=identify(row.service,row.path);return row;
}
export function compileCatalog(registry,readFile){
 return registry.cache_domains.map(s=>({id:s.name,description:s.description,rules:[...new Set(s.domain_files.flatMap(f=>readFile(f).split(/\r?\n/).map(x=>x.trim()).filter(x=>x&&!x.startsWith('#'))))].filter(x=>/^(\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(x)).map(x=>({type:x.startsWith('*.')?'wildcard':'exact',domain:x.replace(/^\*\./,'')}))}));
}
