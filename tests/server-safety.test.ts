import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createApp } from "../server/app.ts";
import type { SkillSafety } from "../shared/types.ts";

const files = (body = "First") => [{ path: "SKILL.md", content: `---\nname: audit-fixture\ndescription: Safety integration fixture\n---\n\n${body}\n` }];

test("security review gates install, manual and automatic updates without losing the selected revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "equip-safety-"));
  let verdict: SkillSafety["status"] = "warn";
  let sourceBody = "First";
  const { app, close, runAutoUpdates } = await createApp({
    dataDir: root, autoUpdateIntervalMs: 0,
    safetyResolver: async () => ({ status: verdict, audits: [], scope: "upstream", checkedAt: new Date().toISOString() }),
    sourceResolver: async () => ({ name: "audit-fixture", title: "Audit fixture", source: "owner/repo", description: "Safety integration fixture", author: "owner", requirements: [], files: files(sourceBody), category: "Community", icon: "Sparkles", color: "purple" }),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(done => server.once("listening", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let cookie = "";
  const call = async (route: string, method = "GET", body?: unknown) => {
    const response = await fetch(base + route, { method, headers: { cookie, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    cookie = response.headers.get("set-cookie")?.split(";")[0] ?? cookie;
    return { status: response.status, body: await response.json() };
  };
  try {
    await call("/api/auth/register", "POST", { name: "Test", email: "safety@example.com", password: "correct horse battery" });
    const rejected = await call("/api/skills/install", "POST", { source: "owner/repo", name: "audit-fixture" });
    assert.equal(rejected.status, 409);
    assert.equal((await call("/api/workspace")).body.skills.length, 0);
    const installed = await call("/api/skills/install", "POST", { source: "owner/repo", name: "audit-fixture", auditAcknowledged: true });
    assert.equal(installed.status, 200);
    assert.equal(installed.body.safety.status, "warn");
    const originalRevision = installed.body.revision;
    const skillId = installed.body.id;
    await call(`/api/skills/${skillId}`, "PATCH", { autoUpdate: true });
    sourceBody = "Updated";
    verdict = "fail";
    await runAutoUpdates();
    let workspace = (await call("/api/workspace")).body;
    assert.equal(workspace.skills[0].revision, originalRevision);
    assert.equal(workspace.skills[0].versions.length, 1);
    assert.ok(workspace.skills[0].upstreamRevision);
    assert.ok(workspace.activity.some((event: any) => event.type === "update-review"));
    assert.equal(workspace.sourceRequests?.length ?? 0, 0);
    const update = await call(`/api/skills/${skillId}/update`, "POST", {});
    assert.equal(update.status, 409);
    assert.equal((await call("/api/workspace")).body.skills[0].revision, originalRevision);
    verdict = "unavailable";
    await runAutoUpdates();
    assert.equal((await call("/api/workspace")).body.skills[0].revision, originalRevision);
    verdict = "pass";
    await runAutoUpdates();
    workspace = (await call("/api/workspace")).body;
    assert.notEqual(workspace.skills[0].revision, originalRevision);
    assert.equal(workspace.skills[0].versions.length, 2);
    assert.equal(workspace.skills[0].safety.status, "pass");
  } finally {
    await new Promise<void>(done => server.close(() => done()));
    await close();
    await rm(root, { recursive: true, force: true });
  }
});

test("device-resolved sources cannot bypass audit findings", async () => {
  const root = await mkdtemp(join(tmpdir(), "equip-device-safety-"));
  const { app, close } = await createApp({ dataDir: root, autoUpdateIntervalMs: 0,
    safetyResolver: async (_source, name) => ({ status: name ? "fail" : "unscanned", audits: [], scope: "upstream", checkedAt: new Date().toISOString() }),
    sourceResolver: async () => { throw new Error("Private source unavailable"); },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(done => server.once("listening", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let cookie = "";
  const post = async (route: string, body: unknown, token?: string) => {
    const response = await fetch(base + route, { method: "POST", headers: { cookie, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    cookie = response.headers.get("set-cookie")?.split(";")[0] ?? cookie;
    return { status: response.status, body: await response.json() };
  };
  try {
    await post("/api/auth/register", { name: "Test", email: "device-safety@example.com", password: "correct horse battery" });
    const queued = await post("/api/skills/install", { source: "owner/repo" });
    assert.equal(queued.status, 202);
    const auth = await post("/api/device/authorize", { name: "Fixture", os: "linux", arch: "x64" });
    await post("/api/device/approve", { userCode: auth.body.userCode });
    const connected = await post("/api/device/token", { deviceCode: auth.body.deviceCode });
    const resolved = await post("/api/device/source", { requestId: queued.body.id, resolved: { source: "owner/repo", name: "audit-fixture", revision: "fixture-1", files: files() } }, connected.body.token);
    assert.equal(resolved.status, 409);
    const workspace = await fetch(base + "/api/workspace", { headers: { cookie } }).then(r => r.json());
    assert.equal(workspace.skills.length, 0);
    assert.equal(workspace.sourceRequests.length, 1);
  } finally {
    await new Promise<void>(done => server.close(() => done()));
    await close();
    await rm(root, { recursive: true, force: true });
  }
});
