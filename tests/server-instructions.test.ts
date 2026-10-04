import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../server/app.ts";
import { skillRevision } from "../shared/library.ts";

let base = "";
let closeAll: () => Promise<void>;

before(async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "equip-instructions-"));
  const instance = await createApp({ dataDir, autoUpdateIntervalMs: 0 });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closeAll = async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await instance.close();
    await rm(dataDir, { recursive: true, force: true });
  };
});
after(async () => closeAll());

async function call(route: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${route}`, { method, headers: {
    ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers,
  }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = response.status === 304 ? undefined : await response.json();
  return { response, body: data, cookie: response.headers.get("set-cookie")?.split(";")[0] };
}

async function account(email: string) {
  const result = await call("/api/auth/register", "POST", { name: "Owner", email, password: "correct horse battery" });
  assert.equal(result.response.status, 201);
  return result.cookie!;
}

async function device(cookie: string) {
  const authorization = await call("/api/device/authorize", "POST", { name: "Laptop", os: "linux", arch: "x64" });
  await call("/api/device/approve", "POST", { userCode: authorization.body.userCode }, { cookie });
  const token = await call("/api/device/token", "POST", { deviceCode: authorization.body.deviceCode });
  return { id: token.body.deviceId as string, authorization: `Bearer ${token.body.token}` };
}

const files = (filename: "CLAUDE.md" | "AGENTS.md", content: string) => [{ path: filename, content }];

test("instruction documents validate, publish, conflict, and roll back", async () => {
  const cookie = await account("instruction-crud@example.com");
  const invalid = await call("/api/instructions", "POST", {
    title: "Bad", filename: "CLAUDE.md", scope: "global", files: [{ path: "CLAUDE.md", content: "x", encoding: "base64" }],
  }, { cookie });
  assert.equal(invalid.response.status, 400);
  const created = await call("/api/instructions", "POST", {
    title: "Global guidance", filename: "AGENTS.md", scope: "global",
    files: [{ path: "AGENTS.md", content: "First\n", mode: 0o664 }],
  }, { cookie });
  assert.match(created.body.id, /^instruction_/);
  assert.equal(created.body.revision, "");
  const published = await call(`/api/instructions/${created.body.id}/publish`, "POST", {}, { cookie });
  assert.equal(published.response.status, 200);
  assert.equal(published.body.files[0].content, "First\n");
  assert.equal(published.body.files[0].mode, 0o664);
  const firstVersion = published.body.versions[0].id;
  const duplicate = await call("/api/instructions", "POST", {
    title: "Duplicate", filename: "AGENTS.md", scope: "global", files: files("AGENTS.md", "Second\n"),
  }, { cookie });
  const conflict = await call(`/api/instructions/${duplicate.body.id}/publish`, "POST", {}, { cookie });
  assert.equal(conflict.response.status, 409);
  await call(`/api/instructions/${created.body.id}`, "PATCH", { draft: files("AGENTS.md", "Changed\n") }, { cookie });
  const changed = await call(`/api/instructions/${created.body.id}/publish`, "POST", { expectedRevision: published.body.revision }, { cookie });
  assert.equal(changed.body.files[0].content, "Changed\n");
  const stale = await call(`/api/instructions/${created.body.id}`, "PATCH", { expectedRevision: published.body.revision, title: "stale" }, { cookie });
  assert.equal(stale.response.status, 409);
  const rolledBack = await call(`/api/instructions/${created.body.id}/rollback`, "POST", {
    versionId: firstVersion, expectedRevision: changed.body.revision,
  }, { cookie });
  assert.equal(rolledBack.body.files[0].content, "First\n");
});

test("devices receive targeted instructions and publish reviewed local conflicts", async () => {
  const cookie = await account("instruction-device@example.com");
  const connected = await device(cookie);
  const auth = { authorization: connected.authorization };
  await call("/api/device/heartbeat", "POST", { instructionLocations: [{
    agent: "claude-code", filename: "AGENTS.md", path: "/home/test/.claude/CLAUDE.md",
  }] }, auth);
  const created = await call("/api/instructions", "POST", {
    title: "Global", filename: "AGENTS.md", scope: "global", files: files("AGENTS.md", "Central\n"),
  }, { cookie });
  const published = await call(`/api/instructions/${created.body.id}/publish`, "POST", {}, { cookie });
  const desired = await call("/api/device/desired", "GET", undefined, auth);
  assert.equal(desired.body.instructions.length, 1);
  assert.deepEqual(desired.body.instructions[0].versions, []);
  const local = files("AGENTS.md", "Local\n");
  await call("/api/device/receipts", "POST", { generation: desired.body.generation, receipts: [{
    kind: "instructions", skillId: created.body.id, agent: "claude-code", revision: published.body.revision,
    status: "conflicted", timestamp: new Date().toISOString(), localFiles: local,
  }] }, auth);
  const workspace = await call("/api/workspace", "GET", undefined, { cookie });
  const conflictReceipt = workspace.body.devices.find((item: any) => item.id === connected.id).receipts[0];
  const expectedLocalRevision = skillRevision(local);
  const resolved = await call(`/api/devices/${connected.id}/instructions/resolve`, "POST", {
    instructionId: created.body.id, agent: "claude-code", action: "publish",
    expectedRevision: published.body.revision, expectedLocalRevision,
  }, { cookie });
  assert.equal(resolved.response.status, 200, JSON.stringify(resolved.body));
  const document = await call(`/api/instructions/${created.body.id}`, "GET", undefined, { cookie });
  assert.equal(document.body.files[0].content, "Local\n");
  assert.equal(conflictReceipt.kind, "instructions");

  const preserve = await call(`/api/devices/${connected.id}/instructions/resolve`, "POST", {
    instructionId: created.body.id, agent: "claude-code", action: "preserve",
    expectedRevision: document.body.revision, expectedLocalRevision,
  }, { cookie });
  assert.equal(preserve.response.status, 200);
  const queued = await call("/api/device/desired", "GET", undefined, auth);
  assert.equal(Object.values(queued.body.instructionResolutions)[0], "preserve");
  await call("/api/device/receipts", "POST", { generation: queued.body.generation, receipts: [{
    kind: "instructions", skillId: created.body.id, agent: "claude-code", revision: document.body.revision,
    status: "conflicted", timestamp: new Date().toISOString(), localFiles: local,
  }] }, auth);
  const notYetApplied = await call("/api/device/desired", "GET", undefined, auth);
  assert.equal(Object.values(notYetApplied.body.instructionResolutions)[0], "preserve");
  await call("/api/device/receipts", "POST", { generation: queued.body.generation, receipts: [{
    kind: "instructions", skillId: created.body.id, agent: "claude-code", revision: document.body.revision,
    status: "conflicted", timestamp: new Date().toISOString(), localFiles: local, instructionResolution: "preserve",
  }] }, auth);
  const preserved = await call("/api/device/desired", "GET", undefined, auth);
  assert.equal(preserved.body.instructions.length, 0);
  assert.deepEqual(preserved.body.instructionResolutions, {});

  await call(`/api/instructions/${created.body.id}`, "DELETE", undefined, { cookie });
  const removedResolution = await call(`/api/devices/${connected.id}/instructions/resolve`, "POST", {
    instructionId: created.body.id, agent: "claude-code", action: "preserve", expectedLocalRevision,
  }, { cookie });
  assert.equal(removedResolution.response.status, 200);
  const removedQueued = await call("/api/device/desired", "GET", undefined, auth);
  await call("/api/device/receipts", "POST", { generation: removedQueued.body.generation, receipts: [{
    kind: "instructions", skillId: created.body.id, agent: "claude-code", revision: document.body.revision,
    status: "conflicted", timestamp: new Date().toISOString(), localFiles: local, instructionResolution: "preserve",
  }] }, auth);
  assert.deepEqual((await call("/api/device/desired", "GET", undefined, auth)).body.instructionResolutions, {});
});

test("device local instruction publishing requires opt-in and a current base", async () => {
  const cookie = await account("instruction-local@example.com");
  const connected = await device(cookie);
  const auth = { authorization: connected.authorization };
  const draft = await call("/api/instructions", "POST", { title: "Agents", filename: "AGENTS.md", scope: "global", files: files("AGENTS.md", "One\n") }, { cookie });
  const published = await call(`/api/instructions/${draft.body.id}/publish`, "POST", {}, { cookie });
  const versionCount = published.body.versions.length;
  const importedLocal = [{ path: "AGENTS.md", content: "Imported Claude rules\n", mode: 0o664 }];
  const missing = await call("/api/device/heartbeat", "POST", { instructionLocations: [{
    agent: "claude-code", filename: "CLAUDE.md", path: "/home/test/.claude/CLAUDE.md", localFiles: importedLocal,
  }, { agent: "custom-agent", filename: "team-rules.md", path: "/home/test/.custom/team-rules.md" }] }, auth);
  assert.equal(missing.response.status, 200);
  const imported = await call("/api/instructions/import", "POST", {
    deviceId: connected.id, path: "/home/test/.claude/CLAUDE.md",
    expectedLocalRevision: skillRevision(importedLocal), instructionId: draft.body.id,
    expectedRevision: published.body.revision,
  }, { cookie });
  assert.equal(imported.body.filename, "AGENTS.md");
  assert.equal(imported.body.scope, "global");
  assert.equal(imported.body.draft[0].path, "AGENTS.md");
  assert.equal(imported.body.files[0].content, "One\n");
  assert.equal(imported.body.revision, published.body.revision);
  assert.equal(imported.body.versions.length, versionCount);
  const staleImport = await call("/api/instructions/import", "POST", {
    deviceId: connected.id, path: "/home/test/.claude/CLAUDE.md",
    expectedLocalRevision: skillRevision(importedLocal), instructionId: draft.body.id,
    expectedRevision: "stale",
  }, { cookie });
  assert.equal(staleImport.response.status, 409);
  const untargetedImport = await call("/api/instructions/import", "POST", {
    deviceId: connected.id, path: "/home/test/.claude/CLAUDE.md",
    expectedLocalRevision: skillRevision(importedLocal),
  }, { cookie });
  assert.equal(untargetedImport.response.status, 409);
  const denied = await call("/api/device/instructions/local", "POST", { instructionId: draft.body.id,
    baseRevision: published.body.revision, files: files("AGENTS.md", "Two\n") }, auth);
  assert.equal(denied.response.status, 403);
  await call(`/api/devices/${connected.id}/local-sync`, "PATCH", { enabled: true }, { cookie });
  const localFiles = [{ path: "AGENTS.md", content: "Two\n", mode: 0o664 }];
  const updated = await call("/api/device/instructions/local", "POST", { instructionId: draft.body.id,
    baseRevision: published.body.revision, files: localFiles }, auth);
  assert.equal(updated.body.files[0].content, "Two\n");
  assert.equal(updated.body.files[0].mode, 0o664);
  assert.equal(updated.body.revision, skillRevision(localFiles));
  const afterLocalPublish = await call("/api/workspace", "GET", undefined, { cookie });
  assert.equal(afterLocalPublish.body.activity[0].skillId, draft.body.id);
  assert.equal(afterLocalPublish.body.activity[0].deviceId, connected.id);
  assert.equal(afterLocalPublish.body.activity[0].type, "publish");
  const stale = await call("/api/device/instructions/local", "POST", { instructionId: draft.body.id,
    baseRevision: published.body.revision, files: files("AGENTS.md", "Three\n") }, auth);
  assert.equal(stale.response.status, 409);
});

test("old workers cannot claim a global instruction generation complete", async () => {
  const cookie = await account("instruction-old-worker@example.com");
  const connected = await device(cookie);
  const auth = { authorization: connected.authorization };
  const draft = await call("/api/instructions", "POST", {
    title: "Global", filename: "AGENTS.md", scope: "global", files: files("AGENTS.md", "Rules\n"),
  }, { cookie });
  await call(`/api/instructions/${draft.body.id}/publish`, "POST", {}, { cookie });
  const desired = await call("/api/device/desired", "GET", undefined, auth);
  await call("/api/device/receipts", "POST", { generation: desired.body.generation, receipts: [] }, auth);
  let workspace = await call("/api/workspace", "GET", undefined, { cookie });
  assert.notEqual(workspace.body.devices.find((item: any) => item.id === connected.id).appliedGeneration, desired.body.generation);
  await call("/api/device/heartbeat", "POST", {
    instructionUnavailable: [{ agent: "legacy", reason: "This client has no instruction adapter." }],
  }, auth);
  await call("/api/device/receipts", "POST", { generation: desired.body.generation, receipts: [] }, auth);
  workspace = await call("/api/workspace", "GET", undefined, { cookie });
  assert.equal(workspace.body.devices.find((item: any) => item.id === connected.id).appliedGeneration, desired.body.generation);
});
