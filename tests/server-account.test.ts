import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import type { Workspace } from "../shared/types.ts";
import { registerAccountRoutes } from "../server/account.ts";
import { rateLimitKey } from "../server/rate-limit.ts";
import { openStore } from "../server/storage.ts";
import { createApp } from "../server/app.ts";

function workspace(name: string, email: string): Workspace {
  return {
    name,
    email,
    demo: false,
    generation: 2,
    devices: [{ id: `device_${name}`, name: `${name} laptop`, os: "darwin", arch: "arm64", online: true, lastSeen: new Date().toISOString(), agents: [], receipts: [] }],
    activity: [{ id: `activity_${name}`, type: "publish", title: "Published", description: "Full history", timestamp: new Date().toISOString(), status: "synchronized" }],
    skills: [{
      id: `skill_${name}`, name: `${name.toLowerCase()}-skill`, title: `${name} skill`, description: "Private", author: name,
      source: "custom", kind: "custom", category: "Custom", icon: "package", color: "#000", selected: true, enabled: true,
      autoUpdate: false, revision: "revision", files: [{ path: "SKILL.md", content: `# ${name}\n` }], requirements: [], targets: [],
      versions: [{ id: "version_1", revision: "revision", createdAt: new Date().toISOString(), message: "Original", files: [{ path: "SKILL.md", content: `# ${name}\n` }] }],
      updatedAt: new Date().toISOString(),
    }],
  };
}

test("account export is complete and account-bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "equip-account-"));
  const store = await openStore({ dataDir: root });
  const app = express();
  app.use(express.json());
  const loadWorkspace = async (id: string) => {
    const row = await store.get<{ workspace: string }>("SELECT workspace FROM accounts WHERE id=?", id);
    return row ? JSON.parse(row.workspace) as Workspace : undefined;
  };
  registerAccountRoutes(app, {
    store,
    auth: async (req: any, res, next) => {
      const id = req.get("x-test-account");
      if (!id) return res.status(401).json({ error: "authentication_required" });
      req.accountId = id;
      req.workspace = await loadWorkspace(id);
      next();
    },
    loadWorkspace,
    runAccountLocked: async (_id, work) => work(),
  });
  app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status ?? 500).json({ error: error.message }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const alpha = workspace("Alpha", "alpha@example.test");
    const beta = workspace("Beta", "beta@example.test");
    for (const [id, item] of [["account_alpha", alpha], ["account_beta", beta]] as const)
      await store.run("INSERT INTO accounts(id,name,email,password_hash,workspace,created_at) VALUES(?,?,?,?,?,?)", id, item.name, item.email, "", JSON.stringify(item), new Date().toISOString());

    const response = await fetch(`${base}/api/account/export`, { headers: { "x-test-account": "account_alpha" } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-disposition") ?? "", /equip-account-export\.json/);
    const exported = await response.json() as Workspace;
    assert.equal(exported.email, alpha.email);
    assert.equal(exported.skills[0].files[0].content, "# Alpha\n");
    assert.equal(exported.skills[0].versions[0].files[0].content, "# Alpha\n");
    assert.equal(JSON.stringify(exported).includes("Beta"), false);
    assert.equal((await fetch(`${base}/api/account/export`)).status, 401);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("logout-all and deletion affect only the authenticated account", async () => {
  const root = await mkdtemp(join(tmpdir(), "equip-account-delete-"));
  const store = await openStore({ dataDir: root });
  await store.run("CREATE TABLE IF NOT EXISTS email_authorizations (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL, expires_at BIGINT NOT NULL)");
  const alpha = workspace("Alpha", "alpha@example.test");
  const beta = workspace("Beta", "beta@example.test");
  for (const [id, item] of [["account_alpha", alpha], ["account_beta", beta]] as const) {
    await store.run("INSERT INTO accounts(id,name,email,password_hash,workspace,created_at) VALUES(?,?,?,?,?,?)", id, item.name, item.email, "", JSON.stringify(item), new Date().toISOString());
    await store.run("INSERT INTO sessions(token_hash,account_id,demo,expires_at) VALUES(?,?,?,?)", `session_${id}`, id, 0, Date.now() + 60_000);
    await store.run("INSERT INTO device_tokens(token_hash,account_id,device_id,revoked_at,created_at) VALUES(?,?,?,?,?)", `token_${id}`, id, `device_${id}`, null, Date.now());
    await store.run("INSERT INTO device_authorizations(device_code_hash,user_code,account_id,name,os,arch,status,expires_at) VALUES(?,?,?,?,?,?,?,?)", `code_${id}`, `user_${id}`, id, "Laptop", "darwin", "arm64", "approved", Date.now() + 60_000);
    await store.run("INSERT INTO email_authorizations(token_hash,email,name,expires_at) VALUES(?,?,?,?)", `email_${id}`, item.email, item.name, Date.now() + 60_000);
    await store.run("INSERT INTO auth_rate_limits(key,count,expires_at) VALUES(?,?,?)", rateLimitKey("email-request-address", item.email), 1, Date.now() + 60_000);
    await store.run("INSERT INTO skill_bundles(account_id,hash,files) VALUES(?,?,?)", id, `hash_${id}`, "[]");
    await store.run("INSERT INTO workspace_devices(account_id,device_id,payload) VALUES(?,?,?)", id, `device_${id}`, "{}");
  }
  const loadWorkspace = async (id: string) => {
    const row = await store.get<{ workspace: string }>("SELECT workspace FROM accounts WHERE id=?", id);
    return row ? JSON.parse(row.workspace) as Workspace : undefined;
  };
  const app = express();
  app.use(express.json());
  app.use(async (req: any, _res, next) => {
    req.accountId = req.get("x-test-account");
    req.workspace = req.accountId ? await loadWorkspace(req.accountId) : undefined;
    next();
  });
  registerAccountRoutes(app, { store, auth: (_req, _res, next) => next(), loadWorkspace, runAccountLocked: async (_id, work) => work() });
  app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status ?? 500).json({ error: error.message }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const request = (path: string, method: string, body?: unknown) => fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-test-account": "account_alpha" },
    body: body ? JSON.stringify(body) : undefined,
  });
  try {
    assert.equal((await request("/api/account/logout-all", "POST")).status, 200);
    assert.equal(await store.get("SELECT 1 FROM sessions WHERE account_id=?", "account_alpha"), undefined);
    assert.ok(await store.get("SELECT 1 FROM sessions WHERE account_id=?", "account_beta"));
    assert.ok(await store.get("SELECT 1 FROM device_tokens WHERE account_id=?", "account_alpha"));

    const mismatch = await request("/api/account", "DELETE", { email: "beta@example.test" });
    assert.equal(mismatch.status, 400);
    assert.ok(await store.get("SELECT 1 FROM accounts WHERE id=?", "account_alpha"));

    const deleted = await request("/api/account", "DELETE", { email: " ALPHA@example.test " });
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { deleted: true, localFiles: "retained" });
    for (const table of ["accounts", "sessions", "device_tokens", "device_authorizations", "skill_bundles", "workspace_devices"])
      assert.equal(await store.get(`SELECT 1 FROM ${table} WHERE ${table === "accounts" ? "id" : "account_id"}=?`, "account_alpha"), undefined);
    assert.equal(await store.get("SELECT 1 FROM email_authorizations WHERE email=?", alpha.email), undefined);
    assert.equal(await store.get("SELECT 1 FROM auth_rate_limits WHERE key=?", rateLimitKey("email-request-address", alpha.email)), undefined);
    assert.ok(await store.get("SELECT 1 FROM accounts WHERE id=?", "account_beta"));
    assert.ok(await store.get("SELECT 1 FROM device_tokens WHERE account_id=?", "account_beta"));
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("deleted accounts invalidate device endpoints without requesting local file removal", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "equip-account-app-"));
  const instance = await createApp({ dataDir, autoUpdateIntervalMs: 0, emailAuthEnabled: false });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const post = (path: string, body: unknown, cookie?: string) => fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  try {
    const registration = await post("/api/auth/register", { name: "Delete", email: "delete@example.test", password: "longpassword" });
    assert.equal(registration.status, 201);
    const cookie = registration.headers.get("set-cookie")!.split(";", 1)[0];
    const account = await instance.db.get<{ id: string }>("SELECT id FROM accounts WHERE email=?", "delete@example.test");
    assert.ok(account);
    const deviceToken = "device-secret";
    await instance.db.run(
      "INSERT INTO device_tokens(token_hash,account_id,device_id,revoked_at,created_at) VALUES(?,?,?,?,?)",
      createHash("sha256").update(deviceToken).digest("hex"), account.id, "device_deleted", null, Date.now(),
    );
    const deleted = await fetch(`${base}/api/account`, {
      method: "DELETE",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ email: "delete@example.test" }),
    });
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { deleted: true, localFiles: "retained" });
    const device = await fetch(`${base}/api/device/desired`, { headers: { authorization: `Bearer ${deviceToken}` } });
    assert.equal(device.status, 401);
    assert.deepEqual(await device.json(), { error: "invalid_token" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await instance.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
