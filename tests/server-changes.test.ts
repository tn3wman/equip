import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createApp } from "../server/app.ts";
import { pendingChangeCount, pendingChanges } from "../shared/changes.ts";
import { reviewedFilesRevision } from "../shared/conflicts.ts";
import type { SkillFile, Workspace } from "../shared/types.ts";

const skillFiles = (body: string): SkillFile[] => [{
  path: "SKILL.md",
  content: `---\nname: changes-tool\ndescription: ${body}\n---\n\n${body}\n`,
}];

test("captured updates and reviewed merges remain exact across devices", async () => {
  const root = await mkdtemp(join(tmpdir(), "equip-changes-"));
  let upstreamRevision = "source-r1";
  let upstreamFiles = skillFiles("Source one");
  const { app, close } = await createApp({
    dataDir: join(root, "data"),
    autoUpdateIntervalMs: 0,
    safetyResolver: async () => ({ status: "pass", audits: [], checkedAt: new Date().toISOString(), scope: "upstream" }),
    sourceResolver: async () => ({
      name: "changes-tool", title: "Changes tool", description: "Tracked source", author: "Example",
      source: "https://example.test/changes-tool.git", category: "Community", icon: "tool", color: "blue",
      files: structuredClone(upstreamFiles), requirements: [], revision: upstreamRevision,
      upstreamRevision, upstreamCheckedAt: new Date().toISOString(), sourceType: "github",
    }),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let cookie = "";
  const request = async (route: string, init: RequestInit = {}, bearer?: string) => {
    const headers = new Headers(init.headers);
    if (init.body) headers.set("content-type", "application/json");
    if (cookie) headers.set("cookie", cookie);
    if (bearer) headers.set("authorization", `Bearer ${bearer}`);
    const response = await fetch(base + route, { ...init, headers });
    cookie = response.headers.get("set-cookie")?.split(";")[0] ?? cookie;
    const body = await response.json();
    return { response, body };
  };
  const post = (route: string, body: unknown, bearer?: string) => request(route, { method: "POST", body: JSON.stringify(body) }, bearer);

  try {
    await post("/api/auth/register", { name: "Changes owner", email: "changes@example.com", password: "correct horse battery" });
    const installed = await post("/api/skills/install", { source: "https://example.test/changes-tool.git", name: "changes-tool", auditAcknowledged: true });
    assert.equal(installed.response.status, 200, JSON.stringify(installed.body));
    const skillId = installed.body.id as string;
    const r1 = installed.body.revision as string;

    upstreamRevision = "source-r2";
    upstreamFiles = skillFiles("Captured source two");
    const checked = await post(`/api/skills/${skillId}/check`, {});
    assert.equal(checked.response.status, 200);
    assert.equal(checked.body.proposal.revision, "source-r2");

    upstreamRevision = "source-r3";
    upstreamFiles = skillFiles("Later source three");
    const updated = await post(`/api/skills/${skillId}/update`, { expectedRevision: r1, expectedUpstreamRevision: "source-r2" });
    assert.equal(updated.response.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.revision, "source-r2");
    assert.deepEqual(updated.body.files, skillFiles("Captured source two"));

    const checkedR3 = await post(`/api/skills/${skillId}/check`, {});
    assert.equal(checkedR3.body.proposal.revision, "source-r3");
    assert.equal((await post(`/api/skills/${skillId}/update`, { expectedRevision: r1, expectedUpstreamRevision: "source-r3" })).response.status, 409);
    assert.equal((await post(`/api/skills/${skillId}/update`, { expectedRevision: "source-r2", expectedUpstreamRevision: "missing-proposal" })).response.status, 409);

    const devices: Array<{ id: string; token: string }> = [];
    for (const name of ["Merge source", "Merge peer"]) {
      const authorization = await post("/api/device/authorize", { name, os: "linux", arch: "x64" });
      await post("/api/device/approve", { userCode: authorization.body.userCode });
      const token = await post("/api/device/token", { deviceCode: authorization.body.deviceCode });
      await post("/api/device/heartbeat", {
        name, os: "linux", arch: "x64",
        agents: [{ id: "codex", name: "Codex", path: `/home/${name}/.codex/skills` }],
        instructionLocations: [{ agent: "codex", filename: "AGENTS.md", path: `/home/${name}/AGENTS.md` }],
      }, token.body.token);
      devices.push({ id: token.body.deviceId, token: token.body.token });
    }

    const localFiles: SkillFile[] = [
      ...skillFiles("Original local work"),
      { path: "assets/data.bin", content: "AQID", encoding: "base64", mode: 0o755 },
    ];
    let desired = await request("/api/device/desired", {}, devices[0].token);
    await post("/api/device/receipts", { generation: desired.body.generation, receipts: [{
      skillId, agent: "codex", revision: "source-r2", status: "conflicted",
      timestamp: new Date().toISOString(), localFiles, path: "/home/source/.codex/skills/changes-tool",
    }] }, devices[0].token);
    const localRevision = await reviewedFilesRevision(localFiles);
    const resolveRoute = `/api/devices/${devices[0].id}/resolve`;
    const reviewed = { skillId, agent: "codex", action: "merge", expectedRevision: "source-r2", expectedLocalRevision: localRevision };
    assert.equal((await post(resolveRoute, { ...reviewed, expectedRevision: r1, mergedFiles: localFiles })).response.status, 409);
    assert.equal((await post(resolveRoute, { ...reviewed, expectedLocalRevision: "stale-local", mergedFiles: localFiles })).response.status, 409);
    assert.equal((await post(resolveRoute, { ...reviewed, mergedFiles: skillFiles("<<<<<<< LOCAL") })).response.status, 400);
    assert.equal((await post(resolveRoute, { ...reviewed, mergedFiles: [{ path: "SKILL.md", content: "---\nname: renamed\ndescription: wrong\n---\n" }] })).response.status, 409);

    const mergedFiles: SkillFile[] = [
      ...skillFiles("Reviewed combined work"),
      { path: "assets/data.bin", content: "AQID", encoding: "base64", mode: 0o755 },
    ];
    const merged = await post(resolveRoute, { ...reviewed, mergedFiles });
    assert.equal(merged.response.status, 200, JSON.stringify(merged.body));
    assert.equal(Object.values(merged.body.resolutions).includes("replace"), true);
    assert.deepEqual(merged.body.receipts[0].localFiles, localFiles);
    for (const device of devices) {
      desired = await request("/api/device/desired", {}, device.token);
      const selected = desired.body.skills.find((item: any) => item.id === skillId);
      assert.deepEqual(selected.files, mergedFiles);
      assert.equal(selected.revision, await reviewedFilesRevision(mergedFiles));
    }

    const recovered = await post("/api/device/recovery", {
      skillId, files: localFiles, path: "/home/source/.codex/skills/changes-tool",
    }, devices[0].token);
    assert.equal(recovered.response.status, 200);
    assert.equal(recovered.body.archived, true);
    let workspace = (await request("/api/workspace")).body;
    const selected = workspace.skills.find((item: any) => item.id === skillId);
    const recoveredVersion = selected.versions.find((version: any) => version.message.startsWith("Recovered from "));
    assert.deepEqual(recoveredVersion.files, localFiles);

    const instruction = await post("/api/instructions", {
      title: "Global", filename: "AGENTS.md", scope: "global", files: [{ path: "AGENTS.md", content: "Central\n" }],
    });
    const published = await post(`/api/instructions/${instruction.body.id}/publish`, {});
    desired = await request("/api/device/desired", {}, devices[0].token);
    const instructionLocal: SkillFile[] = [{ path: "AGENTS.md", content: "Local instructions\n", mode: 0o600 }];
    await post("/api/device/receipts", { generation: desired.body.generation, receipts: [{
      kind: "instructions", skillId: instruction.body.id, agent: "codex", revision: published.body.revision,
      status: "conflicted", timestamp: new Date().toISOString(), localFiles: instructionLocal,
    }] }, devices[0].token);
    const instructionReviewed = {
      instructionId: instruction.body.id, agent: "codex", action: "merge",
      expectedRevision: published.body.revision, expectedLocalRevision: await reviewedFilesRevision(instructionLocal),
    };
    const instructionRoute = `/api/devices/${devices[0].id}/instructions/resolve`;
    assert.equal((await post(instructionRoute, { ...instructionReviewed, expectedRevision: "stale-central", mergedFiles: instructionLocal })).response.status, 409);
    assert.equal((await post(instructionRoute, { ...instructionReviewed, expectedLocalRevision: "stale-local", mergedFiles: instructionLocal })).response.status, 409);
    assert.equal((await post(instructionRoute, { ...instructionReviewed, mergedFiles: [{ path: "AGENTS.md", content: "<<<<<<< LOCAL\n" }] })).response.status, 400);
    assert.equal((await post(instructionRoute, { ...instructionReviewed, mergedFiles: [{ path: "OTHER.md", content: "Merged\n" }] })).response.status, 400);
    const mergedInstructions: SkillFile[] = [{ path: "AGENTS.md", content: "Merged instructions\n", mode: 0o644 }];
    const instructionResolved = await post(instructionRoute, { ...instructionReviewed, mergedFiles: mergedInstructions });
    assert.equal(instructionResolved.response.status, 200, JSON.stringify(instructionResolved.body));
    assert.equal(Object.values(instructionResolved.body.instructionResolutions).includes("replace"), true);
    assert.equal(Object.values(instructionResolved.body.instructionResolutionChecks).includes(instructionReviewed.expectedLocalRevision), true);
    for (const device of devices) {
      const state = await request("/api/device/desired", {}, device.token);
      const document = state.body.instructions.find((item: any) => item.id === instruction.body.id);
      assert.deepEqual(document.files, mergedInstructions);
      assert.equal(document.filename, "AGENTS.md");
    }

    const recoveryKey = `recovery:${skillId}:${recoveredVersion.id}`;
    assert.equal((await post("/api/changes/reviewed", { key: "recovery:missing:missing" })).response.status, 404);
    assert.equal((await post("/api/changes/reviewed", { key: recoveryKey })).response.status, 200);
    workspace = (await request("/api/workspace")).body;
    assert.equal(workspace.reviewedChanges.includes(recoveryKey), true);
    assert.equal(pendingChanges(workspace).recovered.some(({ item }) => item.id === skillId), false);

    const ownerCookie = cookie;
    cookie = "";
    await post("/api/auth/register", { name: "Other owner", email: "other-changes@example.com", password: "correct horse battery" });
    assert.equal((await post("/api/changes/reviewed", { key: recoveryKey })).response.status, 404);
    cookie = ownerCookie;
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await close();
    await rm(root, { recursive: true, force: true });
  }
});

test("pending change count combines updates, unique local conflicts, and recoveries", () => {
  const workspace = {
    reviewedChanges: [],
    skills: [{ id: "skill", selected: true, kind: "third-party", revision: "r1", upstreamRevision: "r2", versions: [
      { id: "recovered", message: "Recovered from Laptop", files: [] },
    ] }],
    instructions: [], retiredSkills: [], retiredInstructions: [],
    devices: [{ receipts: [
      { skillId: "skill", agent: "codex", status: "conflicted" },
      { skillId: "skill", agent: "claude", status: "conflicted" },
    ] }],
  } as unknown as Workspace;
  const changes = pendingChanges(workspace);
  assert.equal(changes.updates.length, 1);
  assert.equal(changes.local.length, 2);
  assert.equal(changes.recovered.length, 1);
  assert.equal(pendingChangeCount(workspace), 3);
});
