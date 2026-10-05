import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../server/app.ts";
import type { SkillFile } from "../shared/types.ts";

const skillMarkdown = (body = "First"): SkillFile => ({
  path: "SKILL.md",
  content: `---\nname: update-fixture\ndescription: Update state fixture\n---\n\n${body}\n`,
});

async function fixture(options?: { autoUpdate?: boolean }) {
  const root = await mkdtemp(join(tmpdir(), "equip-update-state-"));
  let revision = "upstream-revision-a";
  let safetyStatus: "pass" | "warn" = "pass";
  let files: SkillFile[] = [
    skillMarkdown(),
    { path: "assets/pixel.bin", content: "AAECAw==", encoding: "base64", mode: 0o644 },
  ];
  const { app, close, runAutoUpdates } = await createApp({
    dataDir: root,
    autoUpdateIntervalMs: 0,
    safetyResolver: async () => ({ status: safetyStatus, audits: [], scope: "upstream", checkedAt: new Date().toISOString() }),
    sourceResolver: async () => ({
      name: "update-fixture",
      title: "Update fixture",
      source: "owner/repo",
      description: "Update state fixture",
      author: "owner",
      requirements: [],
      category: "Community",
      icon: "Sparkles",
      color: "purple",
      revision,
      files: structuredClone(files),
    }),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((done) => server.once("listening", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let cookie = "";
  const call = async (route: string, method = "GET", body?: unknown) => {
    const response = await fetch(base + route, {
      method,
      headers: { cookie, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    cookie = response.headers.get("set-cookie")?.split(";")[0] ?? cookie;
    return { status: response.status, body: await response.json() };
  };
  await call("/api/auth/register", "POST", {
    name: "Test",
    email: `update-${crypto.randomUUID()}@example.com`,
    password: "correct horse battery",
  });
  const installed = await call("/api/skills/install", "POST", { source: "owner/repo", name: "update-fixture" });
  assert.equal(installed.status, 200);
  if (options?.autoUpdate)
    assert.equal((await call(`/api/skills/${installed.body.id}`, "PATCH", { autoUpdate: true })).status, 200);
  return {
    call,
    installed: installed.body,
    runAutoUpdates,
    setSource(nextRevision: string, nextFiles: SkillFile[]) {
      revision = nextRevision;
      files = structuredClone(nextFiles);
    },
    setSafety(status: "pass" | "warn") {
      safetyStatus = status;
    },
    async cleanup() {
      await new Promise<void>((done) => server.close(() => done()));
      await close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("checks and manual updates use complete skill contents instead of the source revision", async () => {
  const instance = await fixture();
  try {
    const { id, revision: selectedRevision } = instance.installed;
    const before = (await instance.call("/api/workspace")).body;
    const original = before.skills[0];
    assert.equal(original.upstreamCheckedAt, undefined);

    instance.setSource("a-different-upstream-hash", original.files);
    const checked = await instance.call(`/api/skills/${id}/check`, "POST");
    assert.equal(checked.status, 200);
    assert.equal(checked.body.upstreamRevision, undefined);
    assert.ok(Date.parse(checked.body.upstreamCheckedAt) > 0);
    let workspace = (await instance.call("/api/workspace")).body;
    assert.equal(workspace.generation, before.generation);

    const unchanged = await instance.call(`/api/skills/${id}/update`, "POST", {});
    assert.equal(unchanged.status, 200);
    assert.equal(unchanged.body.revision, selectedRevision);
    assert.equal(unchanged.body.versions.length, original.versions.length);
    assert.equal(unchanged.body.upstreamRevision, undefined);
    assert.ok(Date.parse(unchanged.body.upstreamCheckedAt) > 0);
    workspace = (await instance.call("/api/workspace")).body;
    assert.equal(workspace.generation, before.generation);

    const changedFiles = structuredClone(original.files);
    changedFiles[1].mode = 0o755;
    instance.setSource("upstream-revision-b", changedFiles);
    const available = await instance.call(`/api/skills/${id}/check`, "POST");
    assert.equal(available.status, 200);
    assert.equal(available.body.upstreamRevision, "upstream-revision-b");
    assert.equal((await instance.call("/api/workspace")).body.generation, before.generation);

    instance.setSafety("warn");
    const gated = await instance.call(`/api/skills/${id}/update`, "POST", {});
    assert.equal(gated.status, 409);
    assert.equal((await instance.call("/api/workspace")).body.skills[0].revision, selectedRevision);
    const updated = await instance.call(`/api/skills/${id}/update`, "POST", { auditAcknowledged: true });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.revision, "upstream-revision-b");
    assert.equal(updated.body.versions.length, original.versions.length + 1);
    assert.equal(updated.body.files[1].mode, 0o755);
    workspace = (await instance.call("/api/workspace")).body;
    assert.equal(workspace.generation, before.generation + 1);

    const confirmed = await instance.call(`/api/skills/${id}/check`, "POST");
    assert.equal(confirmed.body.upstreamRevision, undefined);
    assert.ok(Date.parse(confirmed.body.upstreamCheckedAt) > 0);
    assert.equal((await instance.call("/api/workspace")).body.generation, before.generation + 1);
  } finally {
    await instance.cleanup();
  }
});

test("automatic updates ignore source hash drift but apply changed binary contents", async () => {
  const instance = await fixture({ autoUpdate: true });
  try {
    const before = (await instance.call("/api/workspace")).body;
    const original = before.skills[0];
    instance.setSource("different-hash-same-files", original.files);
    await instance.runAutoUpdates();
    let workspace = (await instance.call("/api/workspace")).body;
    assert.equal(workspace.skills[0].revision, original.revision);
    assert.equal(workspace.skills[0].versions.length, original.versions.length);
    assert.equal(workspace.skills[0].upstreamRevision, undefined);
    assert.ok(Date.parse(workspace.skills[0].upstreamCheckedAt) > 0);
    assert.equal(workspace.generation, before.generation);

    const changedFiles = structuredClone(original.files);
    changedFiles[1].content = "AAECAwQ=";
    instance.setSource("changed-binary", changedFiles);
    await instance.runAutoUpdates();
    workspace = (await instance.call("/api/workspace")).body;
    assert.equal(workspace.skills[0].revision, "changed-binary");
    assert.equal(workspace.skills[0].versions.length, original.versions.length + 1);
    assert.equal(workspace.skills[0].files[1].content, "AAECAwQ=");
    assert.equal(workspace.skills[0].upstreamRevision, undefined);
    assert.ok(Date.parse(workspace.skills[0].upstreamCheckedAt) > 0);
    assert.equal(workspace.generation, before.generation + 1);
  } finally {
    await instance.cleanup();
  }
});
