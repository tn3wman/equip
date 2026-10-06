import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createApp } from "../server/app.ts";
import { PollCache } from "../server/poll-cache.ts";

const databases = [undefined, ...(process.env.EQUIP_TEST_DATABASE_URL ? [process.env.EQUIP_TEST_DATABASE_URL] : [])];
for (const databaseUrl of databases) test(`idle polling never reads workspace, device or bundle blobs (${databaseUrl ? "PostgreSQL" : "SQLite"})`, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "equip-egress-"));
  const {app, db, close, runAutoUpdates} = await createApp({dataDir, databaseUrl, autoUpdateIntervalMs:0,
    databaseCa:process.env.EQUIP_TEST_DATABASE_CA ? await readFile(process.env.EQUIP_TEST_DATABASE_CA,"utf8") : undefined});
  const server = app.listen(0,"127.0.0.1");
  await new Promise<void>(resolve => server.once("listening",resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let other: Awaited<ReturnType<typeof createApp>> | undefined;
  let otherServer: ReturnType<typeof app.listen> | undefined;
  let cookie = "";
  const call = async (route:string, method="GET", body?:unknown, token?:string, etag?:string) => {
    const response = await fetch(base+route,{method,headers:{...(cookie ? {cookie} : {}),
      ...(body !== undefined ? {"content-type":"application/json"} : {}),
      ...(token ? {authorization:`Bearer ${token}`} : {}),...(etag ? {"if-none-match":etag} : {})},
      body:body === undefined ? undefined : JSON.stringify(body)});
    cookie = response.headers.get("set-cookie")?.split(";")[0] ?? cookie;
    return {status:response.status, etag:response.headers.get("etag")!, body:response.status===304 ? undefined : await response.json()};
  };
  const queries:string[] = [];
  const bundleHashes:unknown[] = [];
  for (const method of ["get","all","run"] as const) {
    const original = db[method].bind(db);
    Object.assign(db, {[method]:(sql:string,...values:unknown[]) => { queries.push(sql); if (/^SELECT hash,files/.test(sql)) bundleHashes.push(...values.slice(1)); return original(sql,...values); }});
  }
  const blobs = () => queries.filter(sql => /^SELECT\s+[^;]*(?:\bworkspace\b|\bpayload\b|\bfiles\b)\s*(?:,|FROM)/i.test(sql));
  try {
    assert.equal((await call("/api/auth/register","POST",{name:"Egress owner",email:`egress-${crypto.randomUUID()}@example.test`,password:"correct horse battery"})).status,201);
    const auth = await call("/api/device/authorize","POST",{name:"Laptop",os:"linux",arch:"x64"});
    await call("/api/device/approve","POST",{userCode:auth.body.userCode});
    const connected = await call("/api/device/token","POST",{deviceCode:auth.body.deviceCode});
    const {token,deviceId} = connected.body;
    const files = [{path:"SKILL.md",content:"---\nname: egress-test\ndescription: Egress test\n---\n\nPublished\n"}];
    const created = await call("/api/skills","POST",{title:"Egress test",name:"egress-test",files});
    assert.equal((await call(`/api/skills/${created.body.id}/publish`,"POST",{files})).status,200);
    const unrelatedFiles = [{...files[0],content:files[0].content.replaceAll("egress-test","unrelated-test")}];
    const unrelated = await call("/api/skills","POST",{title:"Unrelated",name:"unrelated-test",files:unrelatedFiles});
    await call(`/api/skills/${unrelated.body.id}/publish`,"POST",{files:unrelatedFiles});
    bundleHashes.length=0;
    const detail = await call(`/api/skills/${created.body.id}`);
    assert.equal(detail.status,200);
    assert.equal(detail.body.files[0].content,files[0].content);
    assert.equal(bundleHashes.length,1,"detail requests must hydrate only the requested item");
    const desired = await call("/api/device/desired","GET",undefined,token);
    const dashboard = await call("/api/workspace?view=dashboard");
    assert.equal(desired.status,200);
    assert.equal(desired.body.skills[0].files[0].content,files[0].content);
    assert.deepEqual(dashboard.body.skills[0].files,[]);
    queries.length=0;
    for (let cycle=0;cycle<5;cycle++) {
      assert.equal((await call("/api/device/desired","GET",undefined,token,desired.etag)).status,304);
      assert.equal((await call("/api/workspace?view=dashboard","GET",undefined,undefined,dashboard.etag)).status,304);
      assert.equal((await call("/api/device/heartbeat","POST",{},token)).status,200);
    }
    assert.deepEqual(blobs(),[]);
    assert.equal(queries.filter(sql => /UPDATE workspace_devices SET/.test(sql)).length,5);
    assert.equal(queries.filter(sql => /UPDATE accounts|INSERT INTO skill_bundles|DELETE FROM workspace_devices/.test(sql)).length,0);
    // Presence transitions invalidate the dashboard without fetching device files.
    const now = Date.now;
    try {
      const later = now()+4*60_000;
      Date.now=()=>later;
      const offline=await call("/api/workspace?view=dashboard","GET",undefined,undefined,dashboard.etag);
      assert.equal(offline.status,200);
      assert.equal(offline.body.devices[0].online,false);
      assert.deepEqual(blobs(),[]);
    } finally {Date.now=now;}
    queries.length=0;
    await runAutoUpdates();
    assert.deepEqual(blobs(),[]);

    // Renames appear in the dashboard, but do not re-download skill content.
    assert.equal((await call("/api/device/heartbeat","POST",{name:"Renamed",localSyncPath:"/tmp/skills",localSyncError:""},token)).status,200);
    const renamed = await call("/api/workspace?view=dashboard","GET",undefined,undefined,dashboard.etag);
    assert.equal(renamed.status,200);
    assert.equal(renamed.body.devices[0].name,"Renamed");
    assert.equal(renamed.body.devices[0].localSync.enabled,false);
    assert.equal((await call("/api/device/desired","GET",undefined,token,desired.etag)).status,304);
    assert.equal(queries.filter(sql => /SELECT hash,files/.test(sql)).length,0);
    queries.length=0;
    // Repeating identical telemetry changes only lastSeen; it does not invalidate either view.
    await call("/api/device/heartbeat","POST",{name:"Renamed",localSyncPath:"/tmp/skills",localSyncError:""},token);
    assert.equal((await call("/api/workspace?view=dashboard","GET",undefined,undefined,renamed.etag)).status,304);
    assert.deepEqual(blobs(),[]);

    // A second process must observe writes even when it has cached the old version.
    other = await createApp({dataDir,databaseUrl,autoUpdateIntervalMs:0,
      databaseCa:process.env.EQUIP_TEST_DATABASE_CA ? await readFile(process.env.EQUIP_TEST_DATABASE_CA,"utf8") : undefined});
    otherServer = other.app.listen(0,"127.0.0.1");
    await new Promise<void>(resolve => otherServer!.once("listening",resolve));
    const otherBase = `http://127.0.0.1:${(otherServer.address() as AddressInfo).port}`;
    const otherBefore = await fetch(otherBase+"/api/device/desired",{headers:{authorization:`Bearer ${token}`}});
    assert.equal(otherBefore.status,200);
    await otherBefore.arrayBuffer();
    const updatedFiles = [{...files[0],content:files[0].content+"Updated\n"}];
    queries.length=0;
    assert.equal((await call(`/api/skills/${created.body.id}/publish`,"POST",{files:updatedFiles})).status,200);
    assert.equal(queries.filter(sql => /^SELECT workspace FROM accounts/.test(sql)).length,1);
    const changed = await call("/api/device/desired","GET",undefined,token,desired.etag);
    assert.equal(changed.status,200);
    assert.equal(changed.body.skills[0].files[0].content,updatedFiles[0].content);
    assert.deepEqual(changed.body.skills[0].versions,[]);
    const otherAfter = await fetch(otherBase+"/api/device/desired",{headers:{authorization:`Bearer ${token}`,"if-none-match":otherBefore.headers.get("etag")!}});
    assert.equal(otherAfter.status,200);
    assert.equal((await otherAfter.json()).skills[0].files[0].content,updatedFiles[0].content);

    await call("/api/device/heartbeat","POST",{instructionLocations:[]},token);
    const locationChanged = await call("/api/device/desired","GET",undefined,token,changed.etag);
    assert.equal(locationChanged.status,200);
    const previousVersion = (await db.get<{version:number|string}>("SELECT version FROM accounts WHERE id=(SELECT account_id FROM workspace_devices WHERE device_id=?)",deviceId))!.version;
    assert.equal((await call("/api/device/heartbeat","POST",{agents:"invalid"},token)).status,400);
    assert.equal((await db.get<{version:number|string}>("SELECT version FROM accounts WHERE id=(SELECT account_id FROM workspace_devices WHERE device_id=?)",deviceId))!.version,previousVersion);
    await call(`/api/devices/${deviceId}/disconnect`,"POST",{mode:"retain"});
    await call("/api/device/disconnected","POST",{mode:"retain"},token);
    assert.equal((await call("/api/device/desired","GET",undefined,token,locationChanged.etag)).status,401);
  } finally {
    if (otherServer) await new Promise<void>(resolve => otherServer!.close(()=>resolve()));
    await other?.close();
    await new Promise<void>(resolve => server.close(()=>resolve()));
    await close();
    await rm(dataDir,{recursive:true,force:true});
  }
});

test("poll cache evicts by bytes and refreshes least recently used entries",() => {
  const cache = new PollCache(8);
  cache.set("a","123"); cache.set("b","456");
  assert.equal(cache.get("a"),"123");
  cache.set("c","789");
  assert.equal(cache.get("b"),undefined);
  assert.equal(cache.get("a"),"123");
  cache.set("huge","too large");
  assert.equal(cache.get("huge"),undefined);
});
