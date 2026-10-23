import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Socket } from "node:net";
import childProcess from "node:child_process";
import test from "node:test";
import { Client } from "pg";
import { updateHeartbeat } from "../server/heartbeat.ts";
import { lockAccount, type Store } from "../server/storage.ts";
import { migrateWorkspaces, readWorkspace, readWorkspaceWithOptions, writeWorkspace } from "../server/workspace-store.ts";
import type { Device, SkillFile, Workspace } from "../shared/types.ts";

// Explicitly opt in to a fresh loopback TLS fixture. Ambient database URLs and
// credentials are never accepted. All fixture tables are connection-local.
const port = Number(process.env.EQUIP_TEST_LOCAL_POSTGRES_PORT ?? 0);
const caPath = process.env.EQUIP_TEST_LOCAL_POSTGRES_CA;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest("hex");
const seen = "2026-10-23T13:01:00Z";

function workspace(device: Device): Workspace {
  return { name: "Fixture", email: "fixture@example.test", demo: false, skills: [], instructions: [],
    devices: [device], activity: [], generation: 1 };
}
function device(): Device {
  return { id: "device", name: "Fixture", os: "linux", arch: "x64", online: true,
    lastSeen: seen, agents: [], receipts: [], localSync: { enabled: true, path: "/before", lastImport: "kept", error: "old" } };
}

// Emit measurements without reading host resources or spawning commands inside
// the network-isolated runner. A separate fixture owner can sample its cgroup.
async function phase<T>(name: string, work: () => Promise<T>): Promise<T> {
  console.log(JSON.stringify({ phase: name, event: "start", unixMs: Date.now(), rssBytes: process.memoryUsage().rss }));
  const start = performance.now();
  try { return await work(); }
  finally { console.log(JSON.stringify({ phase: name, event: "end", unixMs: Date.now(), elapsedMs: performance.now() - start,
    rssBytes: process.memoryUsage().rss, maxRssKiB: process.resourceUsage().maxRSS })); }
}

test("native PostgreSQL compact reports migrate losslessly and bound heartbeat payloads", {
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
  assert.match((await client.query("SELECT version() AS version")).rows[0].version, /PostgreSQL 17\.11/);
  await client.query(`CREATE TEMP TABLE accounts (
    id text PRIMARY KEY,workspace text NOT NULL,version bigint NOT NULL DEFAULT 0,auto_updates integer NOT NULL DEFAULT 0)`);
  // Start with the v1 schema, then apply the same column definition as startup.
  await client.query(`CREATE TEMP TABLE workspace_devices (
    account_id text,device_id text,payload text,version bigint DEFAULT 7,desired_version bigint DEFAULT 3,
    last_seen text DEFAULT '',disconnected integer DEFAULT 0,PRIMARY KEY(account_id,device_id))`);
  await client.query("ALTER TABLE workspace_devices ADD COLUMN receipts TEXT NOT NULL DEFAULT '[]'");
  await client.query(`CREATE TEMP TABLE skill_bundles (
    account_id text,hash text,files text NOT NULL,PRIMARY KEY(account_id,hash))`);
  for (const table of ["accounts", "workspace_devices", "skill_bundles"])
    assert.equal((await client.query("SELECT relpersistence FROM pg_class WHERE oid=$1::regclass", [table])).rows[0].relpersistence, "t");

  const statements: string[] = [];
  let captured: { sql: string; values: unknown[] } | undefined;
  const query = async (sql: string, values: unknown[]) => {
    statements.push(sql);
    let index = 0;
    const native = sql.replace(/\?/g, () => `$${++index}`);
    if (/WITH incoming AS/.test(sql)) {
      captured = { sql: native, values };
      assert.ok(Buffer.byteLength(String(values[0])) < 100_000, "heartbeat SQL must receive compact telemetry");
    }
    return client.query(native, values);
  };
  const store: Store = {
    dialect: "postgres",
    async get<T>(sql: string, ...values: unknown[]) { return (await query(sql, values)).rows[0] as T | undefined; },
    async all<T>(sql: string, ...values: unknown[]) { return (await query(sql, values)).rows as T[]; },
    async run(sql: string, ...values: unknown[]) {
      const result = await query(sql, values);
      assert.equal(result.rows.length, 0, "writes must not return snapshot bodies");
      return { changes: result.rowCount ?? 0 };
    },
    async transaction<T>(work: (transaction: Store) => Promise<T>) {
      await query("BEGIN", []);
      try { const result = await work(store); await query("COMMIT", []); return result; }
      catch (error) { await query("ROLLBACK", []); throw error; }
    },
    async close() {},
  };
  const locked = <T>(account: string, work: () => Promise<T>) => store.transaction(async transaction => {
    assert.ok(await lockAccount(transaction, account));
    return work();
  });
  const metadata = async (account: string) => (await store.get<{ workspace: string }>("SELECT workspace FROM accounts WHERE id=?", account))!.workspace;
  const read = async (account: string, dashboard = false) => JSON.parse(await readWorkspace(store, account, await metadata(account), dashboard)) as Workspace;
  const row = async (account: string) => (await client.query("SELECT payload,receipts,version::int,desired_version::int,last_seen FROM workspace_devices WHERE account_id=$1 AND device_id='device'", [account])).rows[0];
  const versions = async (account: string) => { const saved = await row(account); return [saved.version, saved.desired_version]; };
  const seedLegacy = async (account: string, original: Workspace) => {
    const { devices, ...rest } = original;
    await client.query("INSERT INTO accounts(id,workspace) VALUES($1,$2)", [account, JSON.stringify({ ...rest, devices: [], storageVersion: 1, deviceOrder: devices.map(value => value.id) })]);
    for (const value of devices)
      await client.query("INSERT INTO workspace_devices(account_id,device_id,payload,last_seen) VALUES($1,$2,$3,$4)", [account, value.id, JSON.stringify(value), value.lastSeen]);
  };

  const files: SkillFile[] = [{ path: "SKILL.md", content: "# Fixture\r\nπ 雪\n", mode: 0o640 },
    { path: "bin/run", content: "#!/bin/sh\nexit 0\n", mode: 0o755 },
    { path: "assets/blob.bin", content: Buffer.from([0, 255, 1, 128]).toString("base64"), encoding: "base64", mode: 0o600 }];
  const original = workspace(device());
  original.devices[0].receipts = [
    { skillId: "shared", agent: "codex", revision: "rev", status: "synchronized", timestamp: seen, localFiles: files },
    { skillId: "empty", agent: "codex", revision: "rev", status: "synchronized", timestamp: seen, localFiles: [] },
    { skillId: "absent", agent: "codex", revision: "rev", status: "synchronized", timestamp: seen },
  ];
  original.devices[0].instructionLocations = [
    { agent: "codex", filename: "AGENTS.md", path: "/fixture/AGENTS.md", localFiles: files },
    { agent: "claude", filename: "CLAUDE.md", path: "/fixture/CLAUDE.md", localFiles: [] },
    { agent: "other", filename: "AGENTS.md", path: "/other/AGENTS.md" },
  ];
  await seedLegacy("account", original);
  await seedLegacy("other", original);
  assert.equal((await row("account")).receipts, "[]", "old rows receive the default column value");
  const migrationStart = statements.length;
  await migrateWorkspaces(store);
  for (const account of ["account", "other"]) {
    const saved = await row(account);
    assert.equal(JSON.parse(await metadata(account)).storageVersion, 2);
    assert.equal(Object.hasOwn(JSON.parse(saved.payload), "receipts"), false);
    assert.equal(JSON.parse(saved.receipts).length, 3);
    assert.equal(saved.payload.includes("localFiles\""), false);
    assert.equal(saved.receipts.includes("localFiles\""), false);
    assert.deepEqual(await read(account), original, "full read restores exact file objects and metadata");
    assert.deepEqual(await read(account, true), original, "dashboard restores exact snapshots too");
    assert.equal(fingerprint((await read(account)).devices), fingerprint(original.devices));
    assert.deepEqual(await versions(account), [8, 4]);
    assert.equal((await store.get<{ count: number }>("SELECT count(*)::int AS count FROM skill_bundles WHERE account_id=?", account))!.count, 2,
      "one shared file bundle plus one empty bundle per account");
  }
  const migrationStatements = statements.slice(migrationStart);
  for (const begin of migrationStatements.flatMap((sql, index) => sql === "BEGIN" ? [index] : [])) {
    const lock = migrationStatements.findIndex((sql, index) => index > begin && /SELECT workspace.*FOR UPDATE/.test(sql));
    const load = migrationStatements.findIndex((sql, index) => index > begin && /SELECT payload,receipts/.test(sql));
    assert.ok(lock > begin && load > lock, "v1 payload read occurs only after locking its account");
  }
  await migrateWorkspaces(store);
  assert.deepEqual(await versions("account"), [8, 4], "migration is idempotent");
  const beforeOther = await row("other");
  const sentinel = JSON.stringify({ id: "sentinel", online: false, array: [null], removed: null });
  await client.query("INSERT INTO workspace_devices(account_id,device_id,payload) VALUES('account','sentinel',$1)", [sentinel]);
  const heartbeat = (patch: Record<string, unknown>, time = seen) => locked("account", () => updateHeartbeat(store, "account", "device", patch, time));
  await heartbeat({});
  assert.deepEqual(await versions("account"), [8, 4]);
  await heartbeat({ name: "Renamed", localSync: { path: "/after", error: null } });
  assert.deepEqual(await versions("account"), [9, 4]);
  assert.deepEqual(JSON.parse((await row("account")).payload).localSync, { enabled: true, path: "/after", lastImport: "kept" });
  await heartbeat({ name: "Renamed", localSync: { path: "/after", error: null } }, "later");
  assert.deepEqual(await versions("account"), [9, 4], "repeated telemetry changes presence only");
  await heartbeat({ instructionLocations: original.devices[0].instructionLocations });
  assert.deepEqual(await versions("account"), [9, 4], "repacked identical snapshots do not invalidate desired state");
  for (const [patch, expected] of [
    [{ instructionLocations: [] }, [10, 5]],
    [{ instructionLocations: [] }, [10, 5]],
    [{ instructionUnavailable: [{ agent: "codex", reason: "missing" }] }, [11, 6]],
    [{ instructionLocations: null }, [12, 7]],
  ] as const) { await heartbeat(patch); assert.deepEqual(await versions("account"), expected); }
  assert.deepEqual(await row("other"), beforeOther, "account-scoped heartbeat leaves other devices intact");
  assert.equal((await updateHeartbeat(store, "missing", "device", {}, seen)).changes, 0);
  await client.query("UPDATE workspace_devices SET disconnected=1 WHERE account_id='other'");
  assert.equal((await updateHeartbeat(store, "other", "device", {}, seen)).changes, 0);
  await client.query("UPDATE workspace_devices SET disconnected=0 WHERE account_id='other'");
  assert.equal((await client.query("SELECT payload FROM workspace_devices WHERE account_id='account' AND device_id='sentinel'")).rows[0].payload, sentinel,
    "heartbeat leaves another device in the same account untouched");
  await updateHeartbeat(store, "account", "sentinel", { localSync: { path: "/new", error: null } }, seen);
  assert.deepEqual(JSON.parse((await client.query("SELECT payload FROM workspace_devices WHERE account_id='account' AND device_id='sentinel'")).rows[0].payload),
    { id: "sentinel", online: true, array: [null], localSync: { enabled: false, path: "/new" }, lastSeen: seen },
    "sparse telemetry defaults local sync, removes object nulls and preserves array nulls");
  const sharedHash = digest(files);
  await client.query("DELETE FROM skill_bundles WHERE account_id='account' AND hash=$1", [sharedHash]);
  await assert.rejects(read("account"), /saved device file bundle is unavailable/, "never hydrate using another account's identical hash");
  assert.deepEqual(await read("other"), original);
  await client.query("INSERT INTO skill_bundles(account_id,hash,files) VALUES('account',$1,$2)", [sharedHash, JSON.stringify(files)]);

  // Deterministic varied text exercises JSON parsing and TOAST without live data.
  // Buffers avoid building millions of temporary single-character string nodes.
  let random = 123456789;
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789 /.,:;-";
  const large = device();
  large.agents = Array.from({ length: 59 }, (_, i) => ({ id: `agent-${i}`, name: `Agent ${i}`, path: `/fixture/agent-${i}` }));
  large.receipts = Array.from({ length: 2490 }, (_, i) => {
    const content = Buffer.alloc(13200);
    for (let offset = 0; offset < content.length; offset++) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      content[offset] = alphabet.charCodeAt(random % alphabet.length);
    }
    return { skillId: `skill-${i}`, agent: `agent-${i % 59}`, revision: `rev-${i}`, status: "synchronized", timestamp: seen,
      localFiles: [{ path: "SKILL.md", content: content.toString(), mode: i % 2 ? 0o644 : 0o640 }] };
  });
  large.receipts[0].localFiles![0].content += "x".repeat(33_850_517 - Buffer.byteLength(JSON.stringify(large)));
  assert.equal(Buffer.byteLength(JSON.stringify(large)), 33_850_517);
  const receiptsHash = fingerprint(large.receipts);
  console.log(JSON.stringify({ fixture: "incident", bytes: 33_850_517, receipts: 2490, agents: 59, payloadSha256: digest(large), receiptsSha256: receiptsHash }));
  await seedLegacy("large", workspace(large));
  await phase("legacy-v1-migration", () => migrateWorkspaces(store));
  let saved = await row("large");
  assert.equal(Object.hasOwn(JSON.parse(saved.payload), "receipts"), false);
  assert.ok(Buffer.byteLength(saved.payload) < 20_000);
  assert.ok(Buffer.byteLength(saved.receipts) < 700_000);
  assert.equal(fingerprint((await read("large")).devices[0].receipts), receiptsHash);
  assert.equal(fingerprint((await read("large", true)).devices[0].receipts), receiptsHash);
  const compactReceipts = saved.receipts;
  const largeHeartbeat = (patch: Record<string, unknown>, time = seen) => locked("large", () => updateHeartbeat(store, "large", "device", patch, time));
  await phase("repeated-heartbeats-with-receipts", async () => {
    for (let i = 0; i < 4; i++) await largeHeartbeat({ agents: large.agents }, `${seen}-${i}`);
  });
  assert.deepEqual(await versions("large"), [8, 4]);
  assert.equal((await row("large")).receipts, compactReceipts, "heartbeat never rewrites report metadata");

  // Maximum supported location count and body size. Every location deliberately
  // shares the exact same 256 KiB file, so only one content bundle should persist.
  const instructionFiles: SkillFile[] = [{ path: "AGENTS.md", content: "# Shared instruction\n".padEnd(256 * 1024, "x"), mode: 0o640 }];
  const locations = Array.from({ length: 200 }, (_, i) => ({ agent: `agent-${i % 59}`, filename: "AGENTS.md",
    project: `/fixture/project-${i}`, path: `/fixture/project-${i}/AGENTS.md`, localFiles: instructionFiles }));
  console.log(JSON.stringify({ fixture: "instruction-snapshots", locations: locations.length,
    sharedFileBytes: Buffer.byteLength(instructionFiles[0].content), wireBytes: Buffer.byteLength(JSON.stringify(locations)), bundleSha256: digest(instructionFiles) }));
  await phase("instruction-snapshots-first-heartbeat", () => largeHeartbeat({ instructionLocations: locations }));
  assert.deepEqual(await versions("large"), [9, 5]);
  await phase("instruction-snapshots-repeated-heartbeats", async () => {
    for (let i = 0; i < 4; i++) await largeHeartbeat({ instructionLocations: locations }, `${seen}-instructions-${i}`);
  });
  assert.deepEqual(await versions("large"), [9, 5]);
  assert.equal((await store.get<{ count: number }>("SELECT count(*)::int AS count FROM skill_bundles WHERE account_id=? AND hash=?", "large", digest(instructionFiles)))!.count, 1);
  saved = await row("large");
  const compactLocations = JSON.parse(saved.payload).instructionLocations;
  assert.equal(new Set(compactLocations.map((location: any) => location.localFilesBundle)).size, 1);
  assert.ok(Buffer.byteLength(saved.payload) < 70_000);
  assert.equal(saved.receipts, compactReceipts);
  const desiredStart = statements.length;
  const desired = JSON.parse(await readWorkspaceWithOptions(store, "large", await metadata("large"), { devices: false, bundles: "desired" }));
  assert.deepEqual(desired.devices, []);
  assert.ok(statements.slice(desiredStart).every(sql => !/SELECT.*(?:workspace_devices|skill_bundles)/.test(sql)),
    "desired workspace avoids reports and snapshot bodies");

  const report = await phase("hydrate-report-ingestion", async () => read("large", true));
  assert.equal(fingerprint(report.devices[0].instructionLocations), fingerprint(locations));
  assert.equal(fingerprint(report.devices[0].receipts), receiptsHash);
  report.devices[0].receipts.forEach(receipt => { receipt.timestamp = "2026-10-23T14:00:00Z"; receipt.managed = true; });
  const reportHash = fingerprint(report.devices[0].receipts);
  await phase("report-ingestion-writeWorkspace", () => locked("large", () => writeWorkspace(store, "large", report)));
  assert.deepEqual(await versions("large"), [10, 6]);
  await phase("report-ingestion-unchanged-writeWorkspace", () => locked("large", () => writeWorkspace(store, "large", report)));
  assert.deepEqual(await versions("large"), [10, 6]);
  const full = await read("large");
  assert.equal(fingerprint(full.devices[0].receipts), reportHash, "report bodies, modes and metadata survive ingestion");
  assert.equal(fingerprint(full.devices[0].instructionLocations), fingerprint(locations));
  assert.equal((await store.get<{ count: number }>("SELECT count(*)::int AS count FROM skill_bundles WHERE account_id=?", "large"))!.count, 2491,
    "report ingestion retains 2490 distinct receipt bodies and one shared instruction bundle");
  const changedLocations = structuredClone(locations);
  changedLocations[0].localFiles = [{ ...instructionFiles[0], content: instructionFiles[0].content.slice(0, -1) + "y" }];
  await phase("instruction-snapshots-changed-heartbeat", () => largeHeartbeat({ instructionLocations: changedLocations }));
  assert.deepEqual(await versions("large"), [11, 7]);
  await largeHeartbeat({ instructionLocations: changedLocations }, "last");
  assert.deepEqual(await versions("large"), [11, 7]);
  assert.equal(fingerprint((await read("large")).devices[0].receipts), reportHash);

  // Retain the native planner guard, now checking compact payload execution.
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
  assert.ok(nodes.some(node => node["Node Type"] === "LockRows"));
  console.log(JSON.stringify({ fixture: "final", payloadBytes: Buffer.byteLength((await row("large")).payload),
    compactReceiptsBytes: Buffer.byteLength((await row("large")).receipts), reportSha256: reportHash,
    postgres: (await client.query("SELECT version() AS version")).rows[0].version }));
});
