import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createApp } from "../server/app.ts";
import { skillRevision } from "../shared/library.ts";
import type { SkillFile } from "../shared/types.ts";

test("a reviewed device conflict can replace the central revision for every device", async () => {
  const root = await mkdtemp(join(tmpdir(), "equip-conflict-publish-"));
  const upstreamFiles = [{
    path: "SKILL.md",
    content: "---\nname: shared-tool\ndescription: Upstream instructions\n---\n\n# Upstream\n",
  }];
  const { app, close } = await createApp({
    dataDir: join(root, "data"),
    autoUpdateIntervalMs: 0,
    safetyResolver: async () => ({
      status: "pass",
      audits: [],
      checkedAt: new Date().toISOString(),
      scope: "upstream",
    }),
    sourceResolver: async () => ({
      name: "shared-tool",
      title: "Shared tool",
      description: "Upstream instructions",
      author: "Upstream author",
      source: "https://example.test/shared-tool.git",
      category: "Community",
      icon: "tool",
      color: "blue",
      files: structuredClone(upstreamFiles),
      requirements: [],
      revision: "upstream-r1",
      upstreamRevision: "upstream-r2",
      upstreamCheckedAt: new Date().toISOString(),
      catalogId: "catalog-shared-tool",
      catalogUrl: "https://example.test/catalog/shared-tool",
      sourceType: "github",
      official: true,
      duplicate: true,
    }),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let cookie = "";
  const request = async (route: string, init: RequestInit = {}, bearer?: string) => {
    const headers = new Headers(init.headers);
    if (init.body) headers.set("content-type", "application/json");
    if (cookie) headers.set("cookie", cookie);
    if (bearer) headers.set("authorization", `Bearer ${bearer}`);
    const response = await fetch(base + route, { ...init, headers });
    cookie = response.headers.get("set-cookie")?.split(";")[0] ?? cookie;
    return { response, body: await response.json() };
  };
  const post = (route: string, body: unknown, bearer?: string) =>
    request(route, { method: "POST", body: JSON.stringify(body) }, bearer);
  try {
    await post("/api/auth/register", {
      name: "Conflict owner",
      email: "conflict-publish@example.com",
      password: "correct horse battery",
    });
    const installed = await post("/api/skills/install", {
      source: "https://example.test/shared-tool.git",
      name: "shared-tool",
      auditAcknowledged: true,
    });
    assert.equal(installed.response.status, 200);
    const skillId = installed.body.id as string;
    const existingDraft = [{ path: "SKILL.md", content: "---\nname: shared-tool\ndescription: Unpublished work\n---\n\n# Unfinished draft\n" }];
    const existingTargets = [{ deviceId: "unrelated-device", agent: "codex", enabled: false }];
    const configured = await request(`/api/skills/${skillId}`, {
      method: "PATCH",
      body: JSON.stringify({ draft: existingDraft, targets: existingTargets, autoUpdate: true }),
    });
    assert.equal(configured.response.status, 200);
    const devices: Array<{ id: string; token: string }> = [];
    for (const name of ["Source laptop", "Peer laptop"]) {
      const authorization = await post("/api/device/authorize", { name, os: "linux", arch: "x64" });
      await post("/api/device/approve", { userCode: authorization.body.userCode });
      const token = await post("/api/device/token", { deviceCode: authorization.body.deviceCode });
      await post("/api/device/heartbeat", {
        name,
        os: "linux",
        arch: "x64",
        agents: [{ id: "claude", name: "Claude", path: `/tmp/${token.body.deviceId}` }],
      }, token.body.token);
      devices.push({ id: token.body.deviceId, token: token.body.token });
    }

    const localFiles: SkillFile[] = [
      {
        path: "SKILL.md",
        content: "---\nname: shared-tool\ndescription: Local instructions\n---\n\n# Local\n",
        mode: 0o600,
      },
      { path: "assets/data.bin", content: "/wAB", encoding: "base64", mode: 0o640 },
      { path: "scripts/run.sh", content: "#!/bin/sh\n", mode: 0o755 },
    ];
    let workspace = (await request("/api/workspace")).body;
    const baseRevision = workspace.skills.find((skill: any) => skill.id === skillId).revision;
    const conflictTimestamp = new Date().toISOString();
    const report = async (status: string, files: SkillFile[] = localFiles, timestamp = conflictTimestamp) =>
      post("/api/device/receipts", {
        generation: workspace.generation,
        receipts: [{
          skillId,
          agent: "claude",
          revision: baseRevision,
          status,
          timestamp,
          localFiles: files,
        }],
      }, devices[0].token);

    await report("synchronized");
    let rejected = await post(`/api/devices/${devices[0].id}/resolve`, {
      skillId,
      agent: "claude",
      action: "publish",
      expectedRevision: baseRevision,
      expectedLocalRevision: skillRevision(localFiles),
    });
    assert.equal(rejected.response.status, 409);

    await report("conflicted");
    rejected = await post(`/api/devices/${devices[0].id}/resolve`, {
      skillId,
      agent: "claude",
      action: "publish",
      expectedRevision: "stale-revision",
      expectedLocalRevision: skillRevision(localFiles),
    });
    assert.equal(rejected.response.status, 409);
    rejected = await post(`/api/devices/${devices[0].id}/resolve`, {
      skillId,
      agent: "claude",
      action: "publish",
      expectedRevision: baseRevision,
      expectedLocalRevision: "stale-local",
    });
    assert.equal(rejected.response.status, 409);
    workspace = (await request("/api/workspace")).body;
    assert.equal(workspace.skills.find((skill: any) => skill.id === skillId).revision, baseRevision);

    const invalidTimestamp = new Date(Date.now() + 2000).toISOString();
    await report("conflicted", [{ path: "SKILL.md", content: "# missing metadata\n" }], invalidTimestamp);
    rejected = await post(`/api/devices/${devices[0].id}/resolve`, {
      skillId,
      agent: "claude",
      action: "publish",
      expectedRevision: baseRevision,
      expectedLocalRevision: skillRevision([{ path: "SKILL.md", content: "# missing metadata\n" }]),
    });
    assert.equal(rejected.response.status, 400);

    const finalTimestamp = new Date(Date.now() + 3000).toISOString();
    await report("conflicted", localFiles, finalTimestamp);
    const published = await post(`/api/devices/${devices[0].id}/resolve`, {
      skillId,
      agent: "claude",
      action: "publish",
      expectedRevision: baseRevision,
      expectedLocalRevision: skillRevision(localFiles),
    });
    assert.equal(published.response.status, 200);
    workspace = (await request("/api/workspace")).body;
    const fork = workspace.skills.find((skill: any) => skill.id === skillId);
    assert.equal(fork.kind, "third-party");
    assert.equal(fork.source, "https://example.test/shared-tool.git");
    assert.equal(fork.author, "Upstream author");
    assert.equal(fork.autoUpdate, false);
    assert.deepEqual(fork.files, localFiles);
    assert.deepEqual(fork.draft, existingDraft);
    assert.deepEqual(fork.targets, existingTargets);
    assert.equal(fork.upstreamRevision, undefined);
    assert.equal(fork.catalogId, "catalog-shared-tool");
    assert.equal(fork.catalogUrl, "https://example.test/catalog/shared-tool");
    assert.equal(fork.sourceType, "github");
    assert.equal(fork.official, true);
    assert.equal(fork.duplicate, true);
    assert.equal(fork.safety.scope, "upstream");
    assert.equal(fork.versions[1].revision, baseRevision);
    assert.equal(workspace.activity[0].status, "pending");

    const desired = await Promise.all(devices.map((device) =>
      request("/api/device/desired", {}, device.token).then((result) => result.body)));
    assert.ok(desired.every((state) => state.skills.find((skill: any) => skill.id === skillId).revision === fork.revision));
    assert.ok(desired.every((state) => JSON.stringify(state.skills.find((skill: any) => skill.id === skillId).files) === JSON.stringify(localFiles)));

    const checked = await post(`/api/skills/${skillId}/check`, {});
    assert.equal(checked.response.status, 200);
    assert.equal(checked.body.upstreamRevision, "upstream-r1");
    assert.deepEqual(checked.body.draft, existingDraft);
    assert.deepEqual(checked.body.targets, existingTargets);

    const rollback = await post(`/api/skills/${skillId}/rollback`, { versionId: fork.versions[1].id });
    assert.equal(rollback.response.status, 200);
    assert.deepEqual(rollback.body.files, upstreamFiles);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await close();
    await rm(root, { recursive: true, force: true });
  }
});
