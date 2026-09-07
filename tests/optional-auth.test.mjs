import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server/main.mjs';

test('fresh installs need no password; enabling, restart, and disabling preserve the selected policy', async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'lc-auth-'));const options={data:path.join(root,'data'),cache:path.join(root,'cache'),logs:path.join(root,'logs'),origin:'http://127.0.0.1',allowHostMismatch:true};
 fs.mkdirSync(options.cache);fs.mkdirSync(options.logs);let app,base;
 const start=async()=>{app=createApp(options);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${app.server.address().port}`;};
 const req=(route,body,headers={})=>fetch(base+'/api/'+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-LanCache-Request':'1',...headers},body:body===undefined?undefined:JSON.stringify(body)});
 try{
  await start();assert.equal((await req('overview')).status,200);assert.equal((await(await req('settings')).json()).passwordRequired,false);assert.equal(fs.existsSync(path.join(options.data,'initial-login.txt')),false);
  assert.equal((await req('password',{password:'new-password-1234'},{Origin:'http://evil.test'})).status,403);
  assert.equal((await req('password',{password:'new-password-1234'})).status,200);assert.equal((await req('overview')).status,401);
  assert.equal((await req('password',{enabled:false})).status,401);
  await app.stop();await start();assert.equal((await req('overview')).status,401);
  const login=await req('login',{password:'new-password-1234'});assert.equal(login.status,200);const Cookie=login.headers.get('set-cookie').split(';')[0];
  assert.equal((await req('password',{enabled:false},{Cookie})).status,200);assert.equal((await req('overview')).status,200);
  await app.stop();await start();assert.equal((await req('overview')).status,200);assert.equal((await(await req('session')).json()).passwordRequired,false);
 }finally{await app?.stop();fs.rmSync(root,{recursive:true});}
});

test('upgrading a legacy password hash does not silently turn protection off',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'lc-auth-legacy-'));const options={data:path.join(root,'data'),cache:root,logs:root,password:'existing-password-1234',allowHostMismatch:true};
 let app=createApp(options);const auth=app.store.get('auth');delete auth.enabled;app.store.set('auth',auth);await app.stop();
 app=createApp({...options,password:undefined});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 try{assert.equal(app.store.get('auth').enabled,true);assert.equal((await fetch(`http://127.0.0.1:${app.server.address().port}/api/overview`)).status,401);}finally{await app.stop();fs.rmSync(root,{recursive:true});}
});
