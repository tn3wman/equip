import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Socket } from "node:net";
import childProcess from "node:child_process";
import test from "node:test";
import { Client } from "pg";
import { updateHeartbeat } from "../server/heartbeat.ts";
import type { Store } from "../server/storage.ts";

// Opt in with the random port and certificate of a fresh, isolated local fixture.
// Never accept EQUIP_TEST_DATABASE_URL or another ambient database connection.
const port = Number(process.env.EQUIP_TEST_LOCAL_POSTGRES_PORT ?? 0);
const caPath = process.env.EQUIP_TEST_LOCAL_POSTGRES_CA;

test("native PostgreSQL heartbeats materialize JSON once and preserve telemetry semantics", {
  skip: !port || !caPath,
}, async t => {
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  const connect = Socket.prototype.connect;
  t.mock.method(Socket.prototype, "connect", function (this: Socket, ...args: any[]) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const options = typeof first === "object" ? first : { port: first, host: args[1] };
    assert.equal(options.host, "127.0.0.1", "unmocked external network access");
    assert.equal(Number(options.port), port, "only the explicit fixture port is allowed");
    return Reflect.apply(connect, this, args);
  });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("unmocked fetch"); });
  for (const method of ["exec", "execFile", "execSync", "execFileSync", "spawn", "spawnSync", "fork"] as const)
    t.mock.method(childProcess, method, () => { throw new Error("unmocked external command"); });
  const client = new Client({ host: "127.0.0.1", port, user: "equip_heartbeat_fixture",
    database: "equip_heartbeat_fixture", ssl: { ca: await readFile(caPath!, "utf8") }, query_timeout: 20_000 });
  await client.connect();
  t.after(() => client.end());
  // A temp table shadows any persistent schema, and disappears on disconnect.
  await client.query(`CREATE TEMP TABLE workspace_devices (
    account_id text,device_id text,payload text,version bigint DEFAULT 7,desired_version bigint DEFAULT 3,
    last_seen text DEFAULT '',disconnected integer DEFAULT 0,PRIMARY KEY(account_id,device_id))`);
  const statements: string[] = [];
  let captured: { sql: string; values: unknown[] };
  const store = { dialect: "postgres", async run(sql: string, ...values: unknown[]) {
    statements.push(sql);
    let index = 0;
    captured = { sql: sql.replace(/\?/g, () => `$${++index}`), values };
    const result = await client.query(captured.sql, values);
    assert.equal(result.rows.length, 0, "heartbeat must not return the payload");
    return { changes: result.rowCount ?? 0 };
  } } as Store;
  const seen = "2026-10-23T13:01:00Z";
  const payload = { id: "device", name: "Fixture", online: false, lastSeen: "old", removed: null,
    receipts: [{ localFiles: [{ path: "SKILL.md", content: "fixture", discarded: null }], array: [null] }],
    localSync: { enabled: true, path: "/before", lastImport: "kept", error: "old" } };
  const initial = JSON.stringify(payload);
  await client.query("INSERT INTO workspace_devices(account_id,device_id,payload,disconnected) VALUES ('account','device',$1,0),('other','device',$1,0),('account','other',$1,0),('account','disconnected',$1,1)", [initial]);
  const row = async () => (await client.query("SELECT payload::jsonb AS payload,version::int,desired_version::int,last_seen FROM workspace_devices WHERE account_id='account' AND device_id='device'")).rows[0];
  assert.equal((await updateHeartbeat(store, "account", "device", {}, seen)).changes, 1);
  let current = await row();
  assert.deepEqual(current, { payload: { id: "device", name: "Fixture", online: true, lastSeen: seen,
    receipts: [{ localFiles: [{ path: "SKILL.md", content: "fixture" }], array: [null] }],
    localSync: payload.localSync }, version: 7, desired_version: 3, last_seen: seen });
  const patch = { name: "Renamed", localSync: { path: "/after", error: null } };
  await updateHeartbeat(store, "account", "device", patch, seen);
  current = await row();
  assert.deepEqual(current.payload.localSync, { enabled: true, path: "/after", lastImport: "kept" });
  assert.equal(current.version, 8);
  assert.equal(current.desired_version, 3);
  await updateHeartbeat(store, "account", "device", patch, "later");
  assert.equal((await row()).version, 8, "repeated telemetry only changes presence");
  for (const [patch, version, desired] of [
    [{ instructionLocations: [] }, 9, 4],
    [{ instructionLocations: [] }, 9, 4],
    [{ instructionUnavailable: [{ agent: "codex", reason: "missing" }] }, 10, 5],
    [{ instructionLocations: null }, 11, 6],
  ] as const) {
    await updateHeartbeat(store, "account", "device", patch, seen);
    current = await row();
    assert.equal(current.version, version);
    assert.equal(current.desired_version, desired);
  }
  await client.query("UPDATE workspace_devices SET payload='{}' WHERE account_id='account' AND device_id='device'");
  await updateHeartbeat(store, "account", "device", { localSync: { path: "/new", error: null } }, seen);
  assert.deepEqual((await row()).payload.localSync, { enabled: false, path: "/new" });
  assert.equal((await updateHeartbeat(store, "missing", "device", {}, seen)).changes, 0);
  assert.equal((await updateHeartbeat(store, "account", "disconnected", {}, seen)).changes, 0);
  const untouched = await client.query("SELECT payload,version::int,desired_version::int,last_seen FROM workspace_devices WHERE account_id<>'account' OR device_id<>'device'");
  assert.equal(untouched.rows.length, 3);
  for (const other of untouched.rows)
    assert.deepEqual(other, { payload: initial, version: 7, desired_version: 3, last_seen: "" });

  // Match the incident's size and shape without any live data. Buffer generation
  // avoids allocating millions of temporary string nodes in the test process.
  let seed = 123456789;
  const letters = "abcdefghijklmnopqrstuvwxyz0123456789 /.,:;-";
  const receipts = Array.from({ length: 2490 }, (_, i) => {
    const content = Buffer.alloc(13200);
    for (let offset = 0; offset < content.length; offset++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      content[offset] = letters.charCodeAt(seed % letters.length);
    }
    return { skillId: `skill-${i}`, agent: `agent-${i % 59}`, revision: `rev-${i}`, status: "synced",
      timestamp: "2026-10-23T13:00:00Z", localFiles: [{ path: "SKILL.md", content: content.toString() }] };
  });
  const large = { id: "device", name: "Fixture", agents: Array.from({ length: 59 }, (_, i) => ({
    id: `agent-${i}`, name: `Agent ${i}`, path: `/fixture/agent-${i}` })), receipts };
  receipts[0].localFiles[0].content += "x".repeat(33_850_517 - Buffer.byteLength(JSON.stringify(large)));
  const value = JSON.stringify(large);
  assert.equal(Buffer.byteLength(value), 33_850_517);
  await client.query("UPDATE workspace_devices SET payload=$1 WHERE account_id='account' AND device_id='device'", [value]);
  const receiptHash = async () => (await client.query("SELECT md5((payload::jsonb->'receipts')::text) AS hash FROM workspace_devices WHERE account_id='account' AND device_id='device'")).rows[0].hash;
  const before = await receiptHash();
  await updateHeartbeat(store, "account", "device", { agents: large.agents, localSync: { path: "/fixture", error: null } }, seen);
  assert.equal(await receiptHash(), before, "embedded receipt files survive unchanged");
  // The actual executed SQL must have separate CTE scans, not planner-inlined
  // copies of the large expressions. EXPLAIN without ANALYZE does not write again.
  const plan = (await client.query("EXPLAIN (VERBOSE,FORMAT JSON) " + captured!.sql, captured!.values)).rows[0]["QUERY PLAN"][0].Plan;
  const nodes: any[] = [];
  const visit = (node: any) => { nodes.push(node); node.Plans?.forEach(visit); };
  visit(plan);
  for (const name of ["previous", "merged"]) {
    assert.equal(nodes.filter(node => node["Subplan Name"] === `CTE ${name}`).length, 1);
    assert.ok(nodes.some(node => node["Node Type"] === "CTE Scan" && node["CTE Name"] === name));
  }
  const merged = nodes.find(node => node["Subplan Name"] === "CTE merged");
  assert.equal(merged.Output.filter((output: string) => output.includes("jsonb_strip_nulls")).length, 1);
  assert.ok(nodes.some(node => node["Node Type"] === "LockRows"), "lock the row before materializing its state");
  assert.ok(statements.every(sql => /UPDATE workspace_devices SET/.test(sql)));
});
