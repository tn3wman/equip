import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server/app.ts';

async function setup(send?: (input:{email:string;url:string})=>Promise<void>) {
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'equip-email-'));
  const instance=await createApp({dataDir,autoUpdateIntervalMs:0,registrationEmail:'tyler@example.test',sendSignIn:send??(async()=>{})});
  const server=instance.app.listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${(server.address() as any).port}`;
  const post=(route:string,body:unknown)=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const close=async()=>{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));await instance.close();fs.rmSync(dataDir,{recursive:true,force:true});};
  return {...instance,base,post,close};
}

test('email proof creates account, preserves approval code, and links cannot be reused',async()=>{
  let delivered='';const app=await setup(async({email,url})=>{assert.equal(email,'tyler@example.test');delivered=url;});
  try {
    assert.deepEqual(await (await fetch(app.base+'/api/auth/config')).json(),{emailSignIn:true});
    assert.equal((await app.post('/api/auth/register',{name:'Tyler',email:'tyler@example.test',password:'longpassword'})).status,403);
    assert.equal((await app.post('/api/auth/email',{email:'tyler@example.test',name:'Tyler',returnTo:'/connect?code=ABCD-EFGH'})).status,200);
    assert.equal((await app.db.get<any>('SELECT COUNT(*) AS count FROM accounts')).count,0);
    const link=new URL(delivered);assert.equal(link.searchParams.get('code'),'ABCD-EFGH');
    const token=link.searchParams.get('token');
    const [first,second]=await Promise.all([app.post('/api/auth/email/consume',{token}),app.post('/api/auth/email/consume',{token})]);
    assert.deepEqual([first.status,second.status].sort(),[200,410]);
    const success=first.status===200?first:second;
    const workspace=await success.json();assert.equal(workspace.demo,false);assert.equal(workspace.name,'Tyler');
    const cookie=success.headers.get('set-cookie')!;assert.match(cookie,/HttpOnly/i);
    const session=await fetch(app.base+'/api/workspace',{headers:{cookie:cookie.split(';')[0]}});
    assert.equal((await session.json()).email,'tyler@example.test');
    assert.equal((await app.db.get<any>('SELECT COUNT(*) AS count FROM accounts')).count,1);
  }finally{await app.close();}
});

test('uninvited email is private, expired link cannot create account, delivery failure can retry',async()=>{
  let delivered='';let fails=true;let sends=0;
  const app=await setup(async({url})=>{sends++;if(fails)throw new Error('provider credential must not reach response');delivered=url;});
  try {
    assert.deepEqual(await (await app.post('/api/auth/email',{email:'unknown@example.test'})).json(),{ok:true});assert.equal(sends,0);
    const failure=await app.post('/api/auth/email',{email:'tyler@example.test'});assert.equal(failure.status,502);assert.doesNotMatch(JSON.stringify(await failure.json()),/credential/);
    fails=false;assert.equal((await app.post('/api/auth/email',{email:'tyler@example.test'})).status,200);assert.equal(sends,2);
    await app.db.run('UPDATE email_authorizations SET expires_at=?',Date.now()-1);
    const token=new URL(delivered).searchParams.get('token');assert.equal((await app.post('/api/auth/email/consume',{token})).status,410);
    assert.equal((await app.db.get<any>('SELECT COUNT(*) AS count FROM accounts')).count,0);
  }finally{await app.close();}
});
