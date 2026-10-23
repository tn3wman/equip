import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import { test, type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { Client, Pool } from "pg";
import { openStore, transactionalStore } from "../server/storage.ts";

function message(type: string, body: Buffer) {
  const header = Buffer.alloc(5);
  header.write(type);
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
}
const ready = message("Z", Buffer.from("I"));
const command = (tag: string) => message("C", Buffer.from(`${tag}\0`));

// Real pg Client/Pool, protocol parser, query timers and release contracts run
// against an in-memory socket. No PostgreSQL service or network is involved.
class PostgresSocket extends Duplex {
  started = false;
  private parsedSql = "";
  statements: string[] = [];
  respond: (sql: string) => "ok" | "stall" | "disconnect" | "error" = () => "ok";
  connect() { queueMicrotask(() => this.emit("connect")); return this; }
  setNoDelay() { return this; }
  ref() { return this; }
  unref() { return this; }
  _read() {}
  _final(callback: () => void) { callback(); this.destroy(); }
  _write(bytes: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    callback();
    queueMicrotask(() => {
      if (this.destroyed) return;
      if (!this.started) {
        this.started = true;
        this.push(Buffer.concat([message("R", Buffer.alloc(4)), ready]));
        return;
      }
      if (bytes[0] === 88) { this.destroy(); return; } // Terminate
      if (bytes[0] === 80) { // Parse an unnamed extended query.
        this.parsedSql = bytes.toString("utf8", 6, bytes.indexOf(0, 6));
        return;
      }
      if ([66, 68, 69].includes(bytes[0])) return; // Bind, Describe, Execute
      assert.ok([81, 83].includes(bytes[0]), "expected Query or Sync");
      const sql = bytes[0] === 83 ? this.parsedSql : bytes.toString("utf8", 5, bytes.length - 1);
      if (bytes[0] === 83)
        this.push(Buffer.concat([message("1", Buffer.alloc(0)), message("2", Buffer.alloc(0)), message("n", Buffer.alloc(0))]));
      this.statements.push(sql);
      const response = this.respond(sql);
      if (response === "stall") return;
      if (response === "disconnect") { this.destroy(new Error("fixture connection lost")); return; }
      if (response === "error") {
        this.push(Buffer.concat([
          message("E", Buffer.from("SERROR\0C08006\0Mfixture SQL failure\0\0")), ready,
        ]));
        return;
      }
      if (sql === "SELECT 1 AS value") {
        const field = Buffer.alloc(18);
        field.writeInt32BE(23, 6); // int4
        field.writeInt16BE(4, 10);
        field.writeInt32BE(-1, 12);
        this.push(Buffer.concat([
          message("T", Buffer.concat([Buffer.from([0, 1]), Buffer.from("value\0"), field])),
          message("D", Buffer.from([0, 1, 0, 0, 0, 1, 49])), command("SELECT 1"), ready,
        ]));
      } else {
        this.push(Buffer.concat([command(sql.startsWith("UPDATE") ? "UPDATE 1" : "SELECT 0"), ready]));
      }
    });
  }
}

async function fixture(t: TestContext, respond?: PostgresSocket["respond"]) {
  t.mock.method(Socket.prototype, "connect", () => { throw new Error("Unmocked network access"); });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unmocked fetch"); });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sockets: PostgresSocket[] = [];
  const clients: Client[] = [];
  const releases: { client: Client; error: unknown }[] = [];
  const removals: Client[] = [];
  let pool!: Pool;
  const connectPool = Pool.prototype.connect;
  t.mock.method(Pool.prototype, "connect", function (this: Pool, ...args: any[]) {
    if (!pool) {
      pool = this;
      pool.on("release", (error, client) => releases.push({ client, error }));
      pool.on("remove", client => removals.push(client));
    }
    return Reflect.apply(connectPool, this, args);
  });
  const connectClient = Client.prototype.connect;
  t.mock.method(Client.prototype, "connect", function (this: Client, ...args: any[]) {
    const socket = new PostgresSocket();
    if (respond) socket.respond = respond;
    sockets.push(socket);
    clients.push(this);
    // Only the fixture transport bypasses TLS; assert the production settings first.
    assert.equal((this.ssl as unknown as { rejectUnauthorized: boolean }).rejectUnauthorized, true);
    const connection = this.connection as unknown as { stream: Duplex; ssl: boolean };
    connection.stream = socket;
    connection.ssl = false;
    this.ssl = false;
    return Reflect.apply(connectClient, this, args);
  });
  const dataDir = await mkdtemp(path.join(tmpdir(), "equip-pg-recovery-"));
  const store = await openStore({ dataDir, databaseUrl: "postgres://fixture@offline.invalid/equip" });
  t.after(async () => {
    const closing = store.close();
    sockets.forEach(socket => socket.destroy());
    await closing;
    await setImmediate();
    await rm(dataDir, { recursive: true, force: true });
  });
  releases.length = 0;
  removals.length = 0;
  assert.equal(pool.options.max, 5);
  assert.equal(pool.options.connectionTimeoutMillis, 10_000);
  return { store, pool, sockets, clients, releases, removals };
}

function observe<T>(promise: Promise<T>) {
  const state: { settled: boolean; error?: unknown; value?: T } = { settled: false };
  const done = promise.then(
    value => { state.settled = true; state.value = value; },
    error => { state.settled = true; state.error = error; },
  );
  return { state, done };
}

async function deadline(t: TestContext, state: { settled: boolean }) {
  await setImmediate();
  t.mock.timers.tick(29_999);
  await setImmediate();
  assert.equal(state.settled, false, "SQL should be allowed up to its deadline");
  t.mock.timers.tick(1);
  await setImmediate();
  assert.equal(state.settled, true, "SQL/cleanup must finish at the 30-second deadline");
}

test("all five stalled pooled clients time out, are discarded once, and a fresh request recovers", async t => {
  const f = await fixture(t, sql => sql === "UPDATE uncertain SET value=1" ? "stall" : "ok");
  const requests = Array.from({ length: 5 }, () => observe(f.store.run("UPDATE uncertain SET value=1")));
  await deadline(t, { get settled() { return requests.every(request => request.state.settled); } });
  await Promise.all(requests.map(request => request.done));
  requests.forEach(request => assert.match(String(request.state.error), /Query read timeout/));
  assert.equal(f.pool.totalCount, 0);
  assert.equal(f.releases.length, 5);
  assert.equal(new Set(f.releases.map(release => release.client)).size, 5);
  assert.equal(f.removals.length, 5);
  assert.equal(f.sockets.flatMap(socket => socket.statements).filter(sql => sql.startsWith("UPDATE uncertain")).length, 5);
  assert.deepEqual(await f.store.get("SELECT 1 AS value"), { value: 1 });
  assert.equal(f.clients.length, 6);
});

for (const stalled of ["BEGIN", "UPDATE uncertain SET value=1", "COMMIT"]) {
  test(`transaction discards a client stalled on ${stalled} without queuing rollback or retrying`, async t => {
    const f = await fixture(t);
    const socket = f.sockets[0];
    socket.respond = sql => sql === stalled ? "stall" : "ok";
    const start = socket.statements.length;
    const request = observe(f.store.transaction(transaction => transaction.run("UPDATE uncertain SET value=1")));
    await deadline(t, request.state);
    await request.done;
    assert.match(String(request.state.error), /Query read timeout/);
    const expected = ["BEGIN", "UPDATE uncertain SET value=1", "COMMIT"];
    assert.deepEqual(socket.statements.slice(start), expected.slice(0, expected.indexOf(stalled) + 1));
    assert.equal(f.releases.length, 1);
    assert.ok(f.releases[0].error);
    assert.equal(f.removals.length, 1);
    assert.equal(socket.destroyed, true);
    assert.deepEqual(await f.store.get("SELECT 1 AS value"), { value: 1 });
    assert.equal(f.clients.length, 2);
  });
}

for (const response of ["stall", "error", "disconnect"] as const) {
  test(`a ${response} during rollback preserves the original exception and discards once`, async t => {
    const f = await fixture(t);
    const socket = f.sockets[0];
    socket.respond = sql => sql === "ROLLBACK" ? response : "ok";
    const original = new Error("original callback failure");
    const start = socket.statements.length;
    const request = observe(f.store.transaction(async () => { throw original; }));
    if (response === "stall") await deadline(t, request.state);
    await request.done;
    await setImmediate();
    assert.equal(request.state.error, original);
    assert.deepEqual(socket.statements.slice(start), ["BEGIN", "ROLLBACK"]);
    assert.equal(f.releases.length, 1);
    assert.ok(f.releases[0].error);
    assert.equal(f.removals.length, 1);
    assert.equal(socket.destroyed, true);
    assert.deepEqual(await f.store.get("SELECT 1 AS value"), { value: 1 });
  });
}

test("connection loss during a transaction query is handled and discarded without retry", async t => {
  const f = await fixture(t);
  const socket = f.sockets[0];
  const start = socket.statements.length;
  socket.respond = sql => sql.startsWith("UPDATE") ? "disconnect" : "ok";
  await assert.rejects(f.store.transaction(transaction => transaction.run("UPDATE uncertain SET value=1")), /fixture connection lost/);
  await setImmediate();
  assert.deepEqual(socket.statements.slice(start), ["BEGIN", "UPDATE uncertain SET value=1"]);
  assert.equal(f.releases.length, 1);
  assert.ok(f.releases[0].error);
  assert.equal(f.removals.length, 1);
  assert.deepEqual(await f.store.get("SELECT 1 AS value"), { value: 1 });
});

test("checked-out client error between queries is handled and prevents commit", async t => {
  const f = await fixture(t);
  const socket = f.sockets[0];
  const start = socket.statements.length;
  const original = new Error("borrowed client failure");
  await assert.rejects(f.store.transaction(async () => {
    // No query callback owns the error while application code is running.
    f.clients[0].emit("error", original);
    return "must not commit";
  }), error => error === original);
  await setImmediate();
  assert.deepEqual(socket.statements.slice(start), ["BEGIN"]);
  assert.equal(f.releases.length, 1);
  assert.equal(f.releases[0].error, original);
  assert.equal(f.removals.length, 1);
  assert.deepEqual(await f.store.get("SELECT 1 AS value"), { value: 1 });
});

test("healthy rollback reuses the connection and nested wrapper retains the read-only transaction", async t => {
  const f = await fixture(t);
  const store = transactionalStore(f.store);
  const original = new Error("validation failure");
  await assert.rejects(store.transaction(async () => { throw original; }), error => error === original);
  assert.equal(f.releases[0].error, undefined);
  assert.equal(f.removals.length, 0);
  const start = f.sockets[0].statements.length;
  await store.transaction(async () => {
    await store.transaction(async nested => {
      assert.deepEqual(await nested.get("SELECT 1 AS value"), { value: 1 });
      assert.deepEqual(await store.get("SELECT 1 AS value"), { value: 1 });
    });
  }, { readOnly: true });
  assert.deepEqual(f.sockets[0].statements.slice(start), [
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", "SELECT 1 AS value", "SELECT 1 AS value", "COMMIT",
  ]);
  assert.equal(f.clients.length, 1);
});
