import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {parseKey,parseLog,digest} from './model.mjs';
const pause=()=>new Promise(r=>setTimeout(r,1));
async function readKey(handle,hash){for(const size of [4096,65536]){const b=Buffer.alloc(size);const {bytesRead}=await handle.read(b,0,size,0);const info=parseKey(b.subarray(0,bytesRead),hash);if(info||bytesRead<size)return info;}return null;}
export class Store{
 constructor(data,cache,logs){
  this.data=data;this.cache=path.resolve(cache);this.logs=path.resolve(logs);fs.mkdirSync(data,{recursive:true});
  this.db=new DatabaseSync(path.join(data,'library.sqlite'));this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY,value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY,service TEXT,product TEXT,version TEXT,kind TEXT,title TEXT,custom_title TEXT,first_seen INTEGER,last_seen INTEGER,bytes_served INTEGER DEFAULT 0,hit_bytes INTEGER DEFAULT 0,requests INTEGER DEFAULT 0);
   CREATE TABLE IF NOT EXISTS files(hash TEXT PRIMARY KEY,relative TEXT NOT NULL,item_id TEXT NOT NULL,size INTEGER NOT NULL,mtime REAL NOT NULL,inode TEXT,key TEXT NOT NULL,generation TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS files_item ON files(item_id);
   CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,time INTEGER,service TEXT,client TEXT,item_id TEXT,status INTEGER,bytes INTEGER,cache TEXT);
   CREATE INDEX IF NOT EXISTS events_time ON events(time);
   CREATE TABLE IF NOT EXISTS buckets(time INTEGER,service TEXT,bytes INTEGER,hits INTEGER,requests INTEGER,PRIMARY KEY(time,service));
   CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,type TEXT,state TEXT,created INTEGER,updated INTEGER,details TEXT);
   CREATE TABLE IF NOT EXISTS manifest_refs(version_id TEXT,hash TEXT,PRIMARY KEY(version_id,hash));
   CREATE TABLE IF NOT EXISTS manifests(id TEXT PRIMARY KEY,title TEXT,version TEXT,retained INTEGER,source TEXT,complete INTEGER);
  `);
  this.db.prepare("UPDATE jobs SET state='interrupted' WHERE state IN ('running','queued')").run();
  this.scanState=this.get('scan')||{state:'not_started',files:0};this.logState=this.get('logState')||{offset:0,inode:null,records:0};
  this.scanning=false;this.logBusy=false;this.mutating=false;this.closed=false;this.inventoryDirty=false;
  this.getIndexedFile=this.db.prepare('SELECT size,mtime,inode,key FROM files WHERE hash=?');
  this.putItem=this.db.prepare('INSERT OR IGNORE INTO items(id,service,product,version,kind,title,first_seen,last_seen) VALUES(?,?,?,?,?,?,?,?)');
  this.putFile=this.db.prepare('INSERT INTO files(hash,relative,item_id,size,mtime,inode,key,generation) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(hash) DO UPDATE SET relative=excluded.relative,item_id=excluded.item_id,size=excluded.size,mtime=excluded.mtime,inode=excluded.inode,key=excluded.key,generation=excluded.generation');
 }
 get(key){const row=this.db.prepare('SELECT value FROM kv WHERE key=?').get(key);return row?JSON.parse(row.value):null;}
 set(key,value){this.db.prepare('INSERT INTO kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));}
 item(i,time=0){this.putItem.run(i.id,i.service,i.product,i.version,i.kind,i.title,time,time);}
 job(type,details={}){const id=randomUUID(),now=Date.now();this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?)').run(id,type,'running',now,now,JSON.stringify(details));return id;}
 progress(id,state,details){this.db.prepare('UPDATE jobs SET state=?,updated=?,details=? WHERE id=?').run(state,Date.now(),JSON.stringify(details),id);}
 jobs(){return this.db.prepare('SELECT * FROM jobs ORDER BY created DESC LIMIT 30').all().map(j=>({...j,details:JSON.parse(j.details)}));}
 async scan(){
  if(this.scanning||this.mutating)throw Error('An index or cleanup job is already running');this.scanning=true;const job=this.job('index');const generation=randomUUID();
  this.scanState={state:'running',startedAt:Date.now(),files:0,bytes:0,skipped:0,errors:0};
  try{
   const root=await fsp.realpath(this.cache);if(root!==this.cache)throw Error('Cache root must be a real directory, not a symlink');
   const stack=[this.cache];let batch=[];
   const flush=()=>{this.db.exec('BEGIN');try{for(const r of batch){this.item(r.info.item);this.putFile.run(r.hash,r.relative,r.info.item.id,r.size,r.mtime,r.inode,r.info.key,generation);}this.db.exec('COMMIT');batch=[];}catch(e){this.db.exec('ROLLBACK');throw e;}};
   while(stack.length&&!this.closed){
    const dir=stack.pop();let entries;try{entries=await fsp.readdir(dir,{withFileTypes:true});}catch(e){this.scanState.errors++;this.scanState.lastError=e.message;continue;}
    const pending=[];for(const ent of entries){const full=path.join(dir,ent.name);if(ent.isSymbolicLink()){this.scanState.skipped++;continue;}
     if(ent.isDirectory()){if(/^[a-f0-9]{2}$/.test(ent.name)&&path.relative(this.cache,full).split(path.sep).length<=2)stack.push(full);continue;}
     if(!ent.isFile()||!/^\w{32}$/.test(ent.name)||!/^[a-f0-9]{32}$/.test(ent.name)){this.scanState.skipped++;continue;}
     pending.push({ent,full});
    }
    let cursor=0;await Promise.all(Array.from({length:Math.min(8,pending.length)},async()=>{while(cursor<pending.length&&!this.closed){const {ent,full}=pending[cursor++];let h;try{
      h=await fsp.open(full,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));const stat=await h.stat();const old=this.getIndexedFile.get(ent.name);const info=old&&old.size===stat.size&&old.mtime===stat.mtimeMs&&old.inode===String(stat.ino)?parseKey(Buffer.from(`\nKEY: ${old.key}\n`),ent.name):await readKey(h,ent.name);
      if(!info){this.scanState.skipped++;continue;}
      batch.push({hash:ent.name,relative:path.relative(this.cache,full),info,size:stat.size,mtime:stat.mtimeMs,inode:String(stat.ino)});this.scanState.files++;this.scanState.bytes+=stat.size;
     }catch(e){if(e.code!=='ENOENT'){this.scanState.errors++;this.scanState.lastError=e.message;}}finally{await h?.close();}
     if(batch.length>=250){flush();this.set('scan',this.scanState);this.progress(job,'running',this.scanState);await pause();}
    }}));
   }
   if(batch.length)flush();
   if(!this.closed&&this.scanState.errors===0)this.db.prepare('DELETE FROM files WHERE generation<>?').run(generation);
   this.scanState.state=this.closed?'interrupted':this.scanState.errors?'partial':'complete';this.scanState.completedAt=Date.now();this.set('scan',this.scanState);this.progress(job,this.scanState.state,this.scanState);
  }catch(e){this.scanState.state='failed';this.scanState.error=e.message;this.set('scan',this.scanState);this.progress(job,'failed',this.scanState);}finally{this.scanning=false;}
  return this.scanState;
 }
 async ingest(){
  if(this.logBusy||this.closed)return;this.logBusy=true;
  let handle;try{
   handle=await fsp.open(path.join(this.logs,'access.log'),'r');const st=await handle.stat();
   let state={...this.logState};const inode=String(st.ino);if(state.inode!==inode||st.size<state.offset){if(state.inode)state.rotationNotice='Log rotated/truncated; reading the new file. Any unread old tail may be absent.';state.offset=0;state.inode=inode;}
   if(state.offset>=st.size){state.totalBytes=st.size;state.caughtUp=true;this.logState=state;return;}
   const buffer=Buffer.alloc(Math.min(2*1024*1024,st.size-state.offset));const {bytesRead}=await handle.read(buffer,0,buffer.length,state.offset);const end=buffer.subarray(0,bytesRead).lastIndexOf(10);
   if(end<0){if(bytesRead===buffer.length&&bytesRead===2*1024*1024){state.offset+=bytesRead;state.rejected=(state.rejected||0)+1;}else return;}
   const rows=end>=0?buffer.subarray(0,end).toString('utf8').split('\n'):[];
   const event=this.db.prepare('INSERT INTO events(time,service,client,item_id,status,bytes,cache) VALUES(?,?,?,?,?,?,?)');
   const update=this.db.prepare('UPDATE items SET first_seen=CASE WHEN first_seen=0 OR first_seen>? THEN ? ELSE first_seen END,last_seen=MAX(last_seen,?),bytes_served=bytes_served+?,hit_bytes=hit_bytes+?,requests=requests+1 WHERE id=?');
   const bucket=this.db.prepare('INSERT INTO buckets VALUES(?,?,?,?,?) ON CONFLICT(time,service) DO UPDATE SET bytes=bytes+excluded.bytes,hits=hits+excluded.hits,requests=requests+1');
   this.db.exec('BEGIN');try{
    for(const line of rows){const r=parseLog(line);if(!r)continue;if(['MISS','EXPIRED','UPDATING','REVALIDATED'].includes(r.cache)&&[200,206].includes(r.status))this.inventoryDirty=true;this.item(r.item,r.time);const hit=r.cache==='HIT'?r.bytes:0;event.run(r.time,r.service,r.client,r.item.id,r.status,r.bytes,r.cache);update.run(r.time,r.time,r.time,r.bytes,hit,r.item.id);bucket.run(Math.floor(r.time/10000)*10000,r.service,r.bytes,hit,1);state.records++;}
    if(end>=0)state.offset+=end+1;state.totalBytes=st.size;state.caughtUp=state.offset>=st.size-1;state.updatedAt=Date.now();state.error=null;this.set('logState',state);
    this.db.prepare('DELETE FROM events WHERE id < (SELECT MAX(id)-20000 FROM events)').run();
    this.db.prepare('DELETE FROM buckets WHERE time<?').run(Date.now()-30*86400000);this.db.exec('COMMIT');this.logState=state;
   }catch(e){this.db.exec('ROLLBACK');throw e;}
  }catch(e){this.logState.error=e.message;}finally{await handle?.close();this.logBusy=false;}
 }
 library({q='',service='',offset=0}={}){
  const where='WHERE (?=\'\' OR i.service=?) AND (?=\'\' OR COALESCE(i.custom_title,i.title) LIKE ? OR i.product LIKE ?)';const args=[service,service,q,`%${q}%`,`%${q}%`];
  const rows=this.db.prepare(`SELECT i.*,COALESCE(f.resident_bytes,0) resident_bytes,COALESCE(f.file_count,0) file_count FROM items i LEFT JOIN (SELECT item_id,SUM(size) resident_bytes,COUNT(*) file_count FROM files GROUP BY item_id) f ON f.item_id=i.id ${where} ORDER BY resident_bytes DESC,i.last_seen DESC LIMIT 100 OFFSET ?`).all(...args,Math.max(0,Number(offset)||0));
  return {rows,total:this.db.prepare(`SELECT COUNT(*) n FROM items i ${where}`).get(...args).n,scan:this.scanState};
 }
 summary(){
  const disk=this.db.prepare('SELECT COALESCE(SUM(size),0) bytes,COUNT(*) files FROM files').get();const totals=this.db.prepare('SELECT COALESCE(SUM(bytes_served),0) bytes,COALESCE(SUM(hit_bytes),0) hits,COALESCE(SUM(requests),0) requests FROM items').get();
  const services=this.db.prepare('SELECT service,SUM(bytes_served) bytes,SUM(hit_bytes) hits,SUM(requests) requests,COUNT(*) items FROM items GROUP BY service ORDER BY bytes DESC').all();
  const events=this.db.prepare('SELECT e.*,COALESCE(i.custom_title,i.title) title,i.version FROM events e JOIN items i ON i.id=e.item_id ORDER BY e.id DESC LIMIT 50').all();
  const chart=this.db.prepare('SELECT time,SUM(bytes) bytes,SUM(hits) hits FROM buckets WHERE time>? GROUP BY time ORDER BY time').all(Date.now()-15*60*1000);
  let space=null;try{const s=fs.statfsSync(this.cache);space={total:s.blocks*s.bsize,available:s.bavail*s.bsize};}catch{}
  return {disk,totals,services,events,chart,space,index:this.scanState,logs:this.logState,jobs:this.jobs(),manifestCount:this.db.prepare('SELECT COUNT(*) n FROM manifests').get().n};
 }
 rename(id,title){if(typeof title!=='string'||title.length>180)throw Error('Name must be at most 180 characters');this.db.prepare('UPDATE items SET custom_title=? WHERE id=?').run(title.trim()||null,id);}
 plan(ids,{mode='items',days=0}={}){
  if(this.scanning||this.mutating)throw Error('Wait for indexing or maintenance to finish');if(!Array.isArray(ids)||ids.length<1||ids.length>100||ids.some(x=>typeof x!=='string'||x.length>100))throw Error('Select 1–100 items');
  let files=[];let protectedCount=0;
  if(mode==='versions'){
   for(const id of ids){const m=this.db.prepare('SELECT * FROM manifests WHERE id=?').get(id);if(!m||!m.complete)throw Error('Version requires an explicitly complete manifest before exclusive-chunk cleanup');}
   const candidates=this.db.prepare(`SELECT DISTINCT f.* FROM files f JOIN manifest_refs r ON r.hash=f.hash WHERE r.version_id IN (${ids.map(()=>'?')})`).all(...ids);
   files=candidates.filter(f=>{const refs=this.db.prepare(`SELECT COUNT(*) n FROM manifest_refs r JOIN manifests m ON m.id=r.version_id WHERE r.hash=? AND m.retained=1 AND r.version_id NOT IN (${ids.map(()=>'?')})`).get(f.hash,...ids);if(refs.n){protectedCount++;return false;}return true;});
  }else{
   files=this.db.prepare(`SELECT f.*,i.last_seen FROM files f JOIN items i ON i.id=f.item_id WHERE f.item_id IN (${ids.map(()=>'?')})`).all(...ids).filter(f=>!days||(f.last_seen>0&&f.last_seen<Date.now()-days*86400000));
   // Imported retained manifests protect chunks even during manual item removal.
   files=files.filter(f=>{if(this.db.prepare('SELECT COUNT(*) n FROM manifest_refs r JOIN manifests m ON m.id=r.version_id WHERE r.hash=? AND m.retained=1').get(f.hash).n){protectedCount++;return false;}return true;});
  }
  if(files.length>100000)throw Error('Select a smaller group: maximum 100,000 files per cleanup job');
  const plan={id:randomUUID(),created:Date.now(),expires:Date.now()+10*60000,mode,ids,files,protectedCount,bytes:files.reduce((n,f)=>n+f.size,0)};this.set('plan:'+plan.id,plan);
  return {id:plan.id,expires:plan.expires,files:files.length,bytes:plan.bytes,protectedCount,mode,requiresConfirmation:'DELETE',note:mode==='versions'?'Exclusive relative to imported retained manifests; completeness depends on the supplied metadata.':'Removes selected cached content. Clients can download it again. History is retained.'};
 }
 async execute(planId,engine){
  const plan=this.get('plan:'+planId);if(!plan||plan.expires<Date.now())throw Error('Cleanup preview expired; create a new preview');if(this.mutating||this.scanning||engine.busy)throw Error('Maintenance is already running');
  if(!engine.enabled)throw Error('Cleanup requires the managed cache engine');
  this.set('plan:'+planId,null);this.mutating=true;engine.busy=true;const job=this.job('cleanup',{files:plan.files.length,bytes:plan.bytes});
  const details={deleted:0,bytes:0,skipped:0,total:plan.files.length};
  (async()=>{let stopped=false;try{
    await engine.stop();stopped=true;
    for(const file of plan.files){
     const target=path.resolve(this.cache,file.relative);if(!target.startsWith(this.cache+path.sep)||!/^([a-f0-9]{2}[\\/]){2}[a-f0-9]{32}$/.test(file.relative))throw Error('Unsafe cached file path');
     if(await fsp.realpath(path.dirname(target))!==path.dirname(target))throw Error('Symlink in cached file path');
     const current=this.db.prepare('SELECT * FROM files WHERE hash=?').get(file.hash);if(!current||current.key!==file.key||current.mtime!==file.mtime){details.skipped++;continue;}
     const protectedRefs=this.db.prepare('SELECT r.version_id FROM manifest_refs r JOIN manifests m ON m.id=r.version_id WHERE r.hash=? AND m.retained=1').all(file.hash);
     if(protectedRefs.some(r=>plan.mode!=='versions'||!plan.ids.includes(r.version_id))){details.skipped++;continue;}
     let handle;try{const st=await fsp.lstat(target);if(!st.isFile()||st.isSymbolicLink()||st.size!==file.size||st.mtimeMs!==file.mtime||String(st.ino)!==file.inode){details.skipped++;continue;}
      handle=await fsp.open(target,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));const buffer=Buffer.alloc(65536);const {bytesRead}=await handle.read(buffer,0,buffer.length,0);if(parseKey(buffer.subarray(0,bytesRead),file.hash)?.key!==file.key){details.skipped++;continue;}await handle.close();handle=null;
      await fsp.unlink(target);this.db.prepare('DELETE FROM files WHERE hash=?').run(file.hash);details.deleted++;details.bytes+=file.size;
     }catch(e){if(e.code==='ENOENT'){this.db.prepare('DELETE FROM files WHERE hash=?').run(file.hash);details.skipped++;}else throw e;}finally{await handle?.close();}
     if((details.deleted+details.skipped)%100===0){this.progress(job,'running',details);await pause();}
    }
    await engine.start();stopped=false;this.progress(job,'complete',details);
   }catch(e){details.error=e.message;this.progress(job,'failed',details);}finally{if(stopped||engine.restartRequired)try{await engine.start();}catch(e){details.recoveryError=e.message;this.progress(job,'failed',details);}engine.busy=false;this.mutating=false;}})();
  return {job};
 }
 importManifests(input){
  if(this.mutating)throw Error('Wait for cleanup to finish');if(!Array.isArray(input.versions)||input.versions.length>1000)throw Error('Expected versions array, up to 1000');
  for(const v of input.versions){if(typeof v.id!=='string'||v.id.length>100||!v.id||typeof v.title!=='string'||v.title.length>180||typeof v.version!=='string'||v.version.length>100||!Array.isArray(v.hashes)||v.hashes.length>100000||v.hashes.some(h=>!/^[a-f0-9]{32}$/.test(h)))throw Error('Invalid manifest: hashes must be actual NGINX cache MD5 filenames');}
  this.db.exec('BEGIN');try{for(const v of input.versions){this.db.prepare('INSERT OR REPLACE INTO manifests VALUES(?,?,?,?,?,?)').run(v.id,v.title,v.version,v.retained===false?0:1,String(v.source||'User supplied').slice(0,300),v.complete===true?1:0);this.db.prepare('DELETE FROM manifest_refs WHERE version_id=?').run(v.id);const put=this.db.prepare('INSERT OR IGNORE INTO manifest_refs VALUES(?,?)');for(const h of v.hashes)put.run(v.id,h);}this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
  return {imported:input.versions.length};
 }
 versions(){return this.db.prepare('SELECT m.*,COUNT(r.hash) referenced_files,COUNT(f.hash) resident_files,COALESCE(SUM(f.size),0) resident_bytes FROM manifests m LEFT JOIN manifest_refs r ON r.version_id=m.id LEFT JOIN files f ON f.hash=r.hash GROUP BY m.id').all();}
 async refreshSteam(){
  const job=this.job('Steam metadata');try{const response=await fetch('https://github.com/regix1/lancache-pics/releases/latest/download/pics_depot_mappings.json',{signal:AbortSignal.timeout(120000)});if(!response.ok)throw Error(`Metadata provider returned HTTP ${response.status}`);
   let n=0;const chunks=[];for await(const b of response.body){n+=b.length;if(n>256*1024*1024)throw Error('Metadata response exceeds 256 MB');chunks.push(b);}const payload=Buffer.concat(chunks);chunks.length=0;const sha256=digest(payload);const data=JSON.parse(payload.toString());const mappings=data.depotMappings||data.DepotMappings;if(!mappings||typeof mappings!=='object')throw Error('Unrecognized Steam metadata format');
   let updated=0;for(const item of this.db.prepare("SELECT id,product FROM items WHERE kind='depot'").all()){const m=mappings[item.product.split(':')[1]];const names=m?.appNames||m?.AppNames;if(Array.isArray(names)&&names.length){const title=[...new Set(names.filter(x=>typeof x==='string'))].join(' / ').slice(0,180);if(title){this.db.prepare('UPDATE items SET title=? WHERE id=?').run(title,item.id);updated++;}}}
   const meta={updated,checkedAt:Date.now(),source:'regix1/lancache-pics (community Steam PICS mapping)',sha256,note:'Names only; depot-to-title mapping does not establish build completeness'};this.set('steamMetadata',meta);this.progress(job,'complete',meta);return meta;
  }catch(e){this.progress(job,'failed',{error:e.message});throw e;}
 }
 close(){this.closed=true;this.db.close();}
}
