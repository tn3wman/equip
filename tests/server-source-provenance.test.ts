import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../server/app.ts";
import type { SkillFile } from "../shared/types.ts";

const files = (name = "provenance-fixture", body = "local") : SkillFile[] => [{
  path: "SKILL.md",
  content: `---\nname: ${name}\ndescription: Provenance fixture\n---\n\n${body}\n`,
}];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "equip-source-provenance-"));
  let resolution: any = {
    name: "provenance-fixture", source: "canonical/source", author: "Upstream author",
    revision: "upstream-r1", files: files(),
  };
  const { app, close } = await createApp({
    dataDir: root,
    autoUpdateIntervalMs: 0,
    sourceResolver: async () => {
      if (resolution instanceof Error) throw resolution;
      return structuredClone(resolution);
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(done => server.once("listening", done));
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
    name: "Test", email: `provenance-${crypto.randomUUID()}@example.com`, password: "correct horse battery",
  });
  const created = await call("/api/skills", "POST", {
    name: "provenance-fixture", title: "Local title", description: "Provenance fixture", files: files(),
  });
  const published = await call(`/api/skills/${created.body.id}/publish`, "POST", { files: files() });
  await call(`/api/skills/${created.body.id}`, "PATCH", {
    enabled: false,
    autoUpdate: true,
    targets: [{ deviceId: "device-1", agent: "codex", enabled: true }],
    draft: files("provenance-fixture", "draft"),
  });
  const deviceDesired = async (token: string, etag?: string) => {
    const response = await fetch(base + "/api/device/desired", {
      headers: { Authorization: `Bearer ${token}`, ...(etag ? { "If-None-Match": etag } : {}) },
    });
    return {
      status: response.status,
      etag: response.headers.get("etag"),
      body: response.status === 304 ? undefined : await response.json(),
    };
  };
  return {
    call, id: created.body.id,
    deviceDesired,
    setResolution(value: any) { resolution = value; },
    async cleanup() {
      await new Promise<void>(done => server.close(() => done()));
      await close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("linking provenance changes metadata without changing deployed state or history", async () => {
  const instance = await fixture();
  try {
    const before = (await instance.call("/api/workspace")).body;
    const original = before.skills[0];
    const authorization = await instance.call("/api/device/authorize", "POST", { name: "Device", os: "linux", arch: "x64" });
    await instance.call("/api/device/approve", "POST", { userCode: authorization.body.userCode });
    const token = await instance.call("/api/device/token", "POST", { deviceCode: authorization.body.deviceCode });
    const desiredBefore = await instance.deviceDesired(token.body.token);
    assert.equal(desiredBefore.body.localSkills[0].kind, "custom");
    const generationBeforeLink = desiredBefore.body.generation;
    const linked = await instance.call(`/api/skills/${instance.id}/source`, "POST", { source: "submitted/source" });
    assert.equal(linked.status, 200);
    assert.equal(linked.body.kind, "third-party");
    assert.equal(linked.body.source, "canonical/source");
    assert.equal(linked.body.author, "Upstream author");
    assert.equal(linked.body.category, "Community");
    assert.equal(linked.body.icon, "package");
    assert.equal(linked.body.autoUpdate, false);
    assert.equal(linked.body.upstreamRevision, undefined);
    assert.ok(Date.parse(linked.body.upstreamCheckedAt) > 0);
    const after = (await instance.call("/api/workspace")).body;
    assert.equal(after.generation, generationBeforeLink + 1);
    for (const key of ["files", "revision", "versions", "draft", "targets", "enabled"])
      assert.deepEqual(after.skills[0][key], original[key], key);
    const desiredAfter = await instance.deviceDesired(token.body.token, desiredBefore.etag!);
    assert.equal(desiredAfter.status, 200);
    assert.notEqual(desiredAfter.etag, desiredBefore.etag);
    assert.equal(desiredAfter.body.localSkills[0].kind, "third-party");
  } finally { await instance.cleanup(); }
});

test("linking records a different upstream revision without replacing local content", async () => {
  const instance = await fixture();
  try {
    instance.setResolution({
      name: "provenance-fixture", source: "canonical/source", author: "Author",
      revision: "upstream-r2", files: files("provenance-fixture", "upstream change"),
    });
    const before = (await instance.call("/api/workspace")).body;
    const linked = await instance.call(`/api/skills/${instance.id}/source`, "POST", { source: "submitted/source" });
    assert.equal(linked.status, 200);
    assert.equal(linked.body.upstreamRevision, "upstream-r2");
    assert.deepEqual(linked.body.files, before.skills[0].files);
    assert.equal((await instance.call("/api/workspace")).body.generation, before.generation + 1);
  } finally { await instance.cleanup(); }
});

test("mismatched and failed provenance resolution leave the skill untouched", async () => {
  const instance = await fixture();
  try {
    const before = (await instance.call("/api/workspace")).body;
    instance.setResolution({ name: "another-skill", source: "wrong/source", author: "Wrong", revision: "wrong", files: files("another-skill") });
    assert.equal((await instance.call(`/api/skills/${instance.id}/source`, "POST", { source: "wrong/source" })).status, 400);
    assert.deepEqual((await instance.call("/api/workspace")).body, before);

    instance.setResolution(new Error("Private source unavailable"));
    const failed = await instance.call(`/api/skills/${instance.id}/source`, "POST", { source: "private/source" });
    assert.equal(failed.status, 400);
    assert.match(failed.body.error, /Private source unavailable/);
    assert.deepEqual((await instance.call("/api/workspace")).body, before);
  } finally { await instance.cleanup(); }
});
