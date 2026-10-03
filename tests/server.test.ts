import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { createApp } from "../server/app.ts";
import { demoCatalog } from "../server/catalog.ts";
import { librarySnapshotRevision } from "../shared/library.ts";
import type { LibrarySnapshotSkill } from "../shared/library.ts";

let base = "";
let shutdown: () => Promise<void>;
let resolverCalls = 0;

before(async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "equip-server-test-"));
  const { app, close } = await createApp({
    dataDir,
    autoUpdateIntervalMs: 0,
    sourceResolver: async (source, name) => {
      resolverCalls += 1;
      const skill = demoCatalog.find(
        (item) => item.source === source && (!name || item.name === name),
      );
      if (!skill) throw new Error("Fixture source not found.");
      return structuredClone(skill);
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  shutdown = async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await close();
    await rm(dataDir, { recursive: true, force: true });
  };
});
after(async () => shutdown());

async function call(route: string, options: RequestInit = {}, cookie?: string) {
  const headers = new Headers(options.headers);
  if (options.body) headers.set("content-type", "application/json");
  if (cookie) headers.set("cookie", cookie);
  const response = await fetch(`${base}${route}`, { ...options, headers });
  const setCookie = response.headers.get("set-cookie")?.split(";")[0];
  const body = await response.json();
  return { response, body, cookie: setCookie };
}
const post = (route: string, body: unknown, cookie?: string) =>
  call(route, { method: "POST", body: JSON.stringify(body) }, cookie);

async function register(email: string) {
  const result = await post("/api/auth/register", {
    name: email.split("@")[0],
    email,
    password: "correct horse battery",
  });
  assert.equal(result.response.status, 201);
  assert.ok(result.cookie);
  return result.cookie!;
}

async function connectDevice(cookie: string, name: string) {
  const authorization = await post("/api/device/authorize", {
    name,
    os: "linux",
    arch: "x64",
  });
  await post("/api/device/approve", { userCode: authorization.body.userCode }, cookie);
  const connected = await post("/api/device/token", {
    deviceCode: authorization.body.deviceCode,
  });
  return {
    deviceId: connected.body.deviceId as string,
    headers: { authorization: `Bearer ${connected.body.token}` },
  };
}

function libraryBody(skills: LibrarySnapshotSkill[]) {
  return {
    id: "nova",
    name: "Nova",
    revision: librarySnapshotRevision(skills),
    skills,
  };
}

function novaSkill(name: string, body = "First", extra = ""): LibrarySnapshotSkill {
  return {
    name,
    title: `${name} title`,
    source: `nova:${name}`,
    kind: "custom",
    files: [
      {
        path: "SKILL.md",
        content: `---\nname: ${name}\ndescription: ${name} description\n---\n\n${body}\n`,
      },
      ...(extra ? [{ path: "reference.txt", content: extra, mode: 0o644 }] : []),
    ],
  };
}

test("demo is explicit, populated, and cannot mutate", async () => {
  const workspace = await call("/api/workspace");
  assert.equal(workspace.response.status, 200);
  assert.equal(workspace.body.demo, true);
  assert.equal(workspace.body.skills.length, 8);
  assert.equal(
    workspace.body.skills.filter((skill: any) => skill.kind === "custom")
      .length,
    2,
  );
  assert.equal(
    workspace.body.skills.filter((skill: any) => skill.upstreamRevision).length,
    2,
  );
  assert.deepEqual(
    workspace.body.devices.map((device: any) => device.online),
    [true, true, false],
  );
  const mutation = await post(
    "/api/skills",
    {
      title: "No",
      name: "no",
      description: "No",
      files: [
        { path: "SKILL.md", content: "---\nname: no\ndescription: no\n---\n" },
      ],
    },
    workspace.cookie,
  );
  assert.equal(mutation.response.status, 403);
});

test("skill inspection requires a real account and rejects server-local sources before resolution", async () => {
  const unauthenticated = await post("/api/skills/inspect", {
    source: "vercel-labs/agent-skills",
    name: "vercel-react-best-practices",
  });
  assert.equal(unauthenticated.response.status, 401);
  const demo = await post("/api/auth/demo", {});
  const demoInspect = await post(
    "/api/skills/inspect",
    { source: "vercel-labs/agent-skills", name: "vercel-react-best-practices" },
    demo.cookie,
  );
  assert.equal(demoInspect.response.status, 403);
  const cookie = await register("inspector@example.com");
  const callsBeforeLocal = resolverCalls;
  const local = await post(
    "/api/skills/inspect",
    { source: "/tmp/server-secret-skill" },
    cookie,
  );
  assert.equal(local.response.status, 400);
  assert.match(local.body.error, /Server-local sources are not allowed/);
  assert.equal(resolverCalls, callsBeforeLocal);
  const remote = await post(
    "/api/skills/inspect",
    { source: "vercel-labs/agent-skills", name: "vercel-react-best-practices" },
    cookie,
  );
  assert.equal(remote.response.status, 200);
  assert.equal(remote.body.name, "vercel-react-best-practices");
  assert.equal(resolverCalls, callsBeforeLocal + 1);
});

test("workflow assistance returns a reviewable valid skill draft", async () => {
  const cookie = await register("assist@example.com");
  const invalid = await post(
    "/api/skills/assist",
    { title: "Release checklist", workflow: "" },
    cookie,
  );
  assert.equal(invalid.response.status, 400);
  assert.match(invalid.body.error, /Describe the workflow/);

  const assisted = await post(
    "/api/skills/assist",
    {
      title: "Release checklist",
      workflow:
        "Review the listed changes.\n\nConfirm every stated acceptance criterion before publishing.",
    },
    cookie,
  );
  assert.equal(assisted.response.status, 200);
  assert.equal(assisted.body.files.length, 1);
  const content = assisted.body.files[0].content;
  assert.match(content, /name: release-checklist/);
  assert.match(content, /## Inputs/);
  assert.match(content, /1\. Review the listed changes\./);
  assert.match(
    content,
    /2\. Confirm every stated acceptance criterion before publishing\./,
  );
});

test("accounts are isolated and passwords are checked", async () => {
  const alpha = await register("alpha@example.com");
  const beta = await register("beta@example.com");
  const files = [
    {
      path: "SKILL.md",
      content:
        "---\nname: private-skill\ndescription: Private account skill\n---\n\n# Private\n",
    },
  ];
  const created = await post(
    "/api/skills",
    {
      title: "Private skill",
      name: "private-skill",
      description: "Private",
      files,
    },
    alpha,
  );
  assert.equal(created.response.status, 200);
  const alphaWorkspace = await call("/api/workspace", {}, alpha);
  const betaWorkspace = await call("/api/workspace", {}, beta);
  assert.equal(alphaWorkspace.body.skills.length, 1);
  assert.equal(betaWorkspace.body.skills.length, 0);
  const badLogin = await post("/api/auth/login", {
    email: "alpha@example.com",
    password: "wrong-password",
  });
  assert.equal(badLogin.response.status, 401);
  const login = await post("/api/auth/login", {
    email: "ALPHA@example.com",
    password: "correct horse battery",
  });
  assert.equal(login.response.status, 200);
});

test("publishing validates frontmatter and rollback restores an immutable version", async () => {
  const cookie = await register("publisher@example.com");
  const first = [
    {
      path: "SKILL.md",
      content:
        "---\nname: writer\ndescription: First revision\n---\n\n# First\n",
    },
  ];
  const created = await post(
    "/api/skills",
    { title: "Writer", name: "writer", description: "Writes", files: first },
    cookie,
  );
  assert.equal(created.body.revision, "");
  const invalidDraft = await call(
    `/api/skills/${created.body.id}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        draft: [{ path: "SKILL.md", content: "# Work in progress" }],
      }),
    },
    cookie,
  );
  assert.equal(invalidDraft.response.status, 200);
  const skillId = created.body.id;
  const invalid = await post(
    `/api/skills/${skillId}/publish`,
    { files: [{ path: "SKILL.md", content: "# Missing metadata" }] },
    cookie,
  );
  assert.equal(invalid.response.status, 400);
  const published1 = await post(
    `/api/skills/${skillId}/publish`,
    { files: first, message: "First" },
    cookie,
  );
  const firstVersion = published1.body.versions[0];
  const second = [
    {
      path: "SKILL.md",
      content:
        "---\nname: writer\ndescription: Second revision\n---\n\n# Second\n",
    },
  ];
  const published2 = await post(
    `/api/skills/${skillId}/publish`,
    { files: second, message: "Second" },
    cookie,
  );
  assert.notEqual(published2.body.revision, firstVersion.revision);
  const rolledBack = await post(
    `/api/skills/${skillId}/rollback`,
    { versionId: firstVersion.id },
    cookie,
  );
  assert.equal(rolledBack.body.revision, firstVersion.revision);
  assert.equal(rolledBack.body.files[0].content, first[0].content);
  const renamed = [
    {
      path: "SKILL.md",
      content:
        "---\nname: renamed-writer\ndescription: Renamed from frontmatter\n---\n",
    },
  ];
  const renamedPublish = await post(
    `/api/skills/${skillId}/publish`,
    { files: renamed },
    cookie,
  );
  assert.equal(renamedPublish.body.name, "renamed-writer");
  assert.equal(renamedPublish.body.description, "Renamed from frontmatter");
});

test("installed skills default to manual updates and draft skills stay out of desired state", async () => {
  const cookie = await register("manual@example.com");
  const installed = await post(
    "/api/skills/install",
    { skillId: "catalog-vercel-react-best-practices" },
    cookie,
  );
  assert.equal(installed.body.autoUpdate, false);
  const duplicate = await post(
    "/api/skills/install",
    { skillId: "catalog-vercel-react-best-practices" },
    cookie,
  );
  assert.equal(duplicate.response.status, 409);
  const draft = await post(
    "/api/skills",
    {
      title: "Draft",
      name: "draft",
      description: "Draft",
      files: [
        {
          path: "SKILL.md",
          content: "---\nname: draft\ndescription: Unpublished draft\n---\n",
        },
      ],
    },
    cookie,
  );
  const auth = await post("/api/device/authorize", {
    name: "Draft client",
    os: "linux",
    arch: "x64",
  });
  await post("/api/device/approve", { userCode: auth.body.userCode }, cookie);
  const token = await post("/api/device/token", {
    deviceCode: auth.body.deviceCode,
  });
  const desired = await call("/api/device/desired", {
    headers: { authorization: `Bearer ${token.body.token}` },
  });
  assert.ok(
    desired.body.skills.some((skill: any) => skill.id === installed.body.id),
  );
  assert.ok(
    !desired.body.skills.some((skill: any) => skill.id === draft.body.id),
  );
});

test("Nova library snapshots are authoritative, atomic, device-bound, and unlink cleanly", async () => {
  const cookie = await register("nova-owner@example.com");
  const otherCookie = await register("nova-other@example.com");
  const owner = await connectDevice(cookie, "Nova owner");
  const peer = await connectDevice(cookie, "Nova peer");

  const independentFiles = [
    {
      path: "SKILL.md",
      content: "---\nname: independent\ndescription: Independent skill\n---\n",
    },
  ];
  const independent = await post(
    "/api/skills",
    { title: "Independent", name: "independent", description: "Independent", files: independentFiles },
    cookie,
  );
  await post(`/api/skills/${independent.body.id}/publish`, { files: independentFiles }, cookie);

  const firstSkills = [
    novaSkill("alpha", "First", "reference"),
    novaSkill("beta"),
    novaSkill("removed-by-snapshot"),
  ];
  const firstBody = libraryBody(firstSkills);
  const linked = await call("/api/device/library", {
    method: "POST",
    headers: owner.headers,
    body: JSON.stringify(firstBody),
  });
  assert.equal(linked.response.status, 200);
  assert.equal(linked.body.skillCount, 3);
  const firstWorkspace = await call("/api/workspace", {}, cookie);
  assert.equal(firstWorkspace.body.librarySource.deviceId, owner.deviceId);
  assert.equal(firstWorkspace.body.skills.find((skill: any) => skill.name === "alpha").autoUpdate, false);

  const repeated = await call("/api/device/library", {
    method: "POST",
    headers: owner.headers,
    body: JSON.stringify(firstBody),
  });
  assert.equal(repeated.body.generation, linked.body.generation);

  const invalid = structuredClone(firstBody);
  invalid.skills[0].title = "Tampered after hashing";
  const rejected = await call("/api/device/library", {
    method: "POST",
    headers: owner.headers,
    body: JSON.stringify(invalid),
  });
  assert.equal(rejected.response.status, 400);
  const afterRejected = await call("/api/workspace", {}, cookie);
  assert.equal(afterRejected.body.generation, linked.body.generation);
  assert.equal(afterRejected.body.skills.find((skill: any) => skill.name === "alpha").title, "alpha title");

  const stolen = await call("/api/device/library", {
    method: "POST",
    headers: peer.headers,
    body: JSON.stringify(firstBody),
  });
  assert.equal(stolen.response.status, 409);

  const alphaBefore = firstWorkspace.body.skills.find((skill: any) => skill.name === "alpha");
  const metadataOnly = structuredClone(firstSkills);
  metadataOnly[0].title = "Renamed alpha";
  metadataOnly.pop();
  const metadataUpdate = await call("/api/device/library", {
    method: "POST",
    headers: owner.headers,
    body: JSON.stringify(libraryBody(metadataOnly)),
  });
  assert.equal(metadataUpdate.response.status, 200);
  const afterMetadata = await call("/api/workspace", {}, cookie);
  const unchangedAlpha = afterMetadata.body.skills.find((skill: any) => skill.name === "alpha");
  assert.equal(unchangedAlpha.revision, alphaBefore.revision);
  assert.equal(unchangedAlpha.versions.length, alphaBefore.versions.length);
  assert.ok(!afterMetadata.body.skills.some((skill: any) => skill.name === "removed-by-snapshot"));

  const enableUpdate = await call(`/api/skills/${unchangedAlpha.id}`, {
    method: "PATCH",
    body: JSON.stringify({ autoUpdate: true }),
  }, cookie);
  assert.equal(enableUpdate.response.status, 409);
  const upstreamCheck = await post(`/api/skills/${unchangedAlpha.id}/check`, {}, cookie);
  assert.equal(upstreamCheck.response.status, 409);
  const upstreamUpdate = await post(`/api/skills/${unchangedAlpha.id}/update`, {}, cookie);
  assert.equal(upstreamUpdate.response.status, 409);

  const beta = afterMetadata.body.skills.find((skill: any) => skill.name === "beta");
  await call(`/api/skills/${beta.id}`, { method: "DELETE" }, cookie);
  const changedSkills = [novaSkill("alpha", "Second", "reference"), novaSkill("beta")];
  const changed = await call("/api/device/library", {
    method: "POST",
    headers: owner.headers,
    body: JSON.stringify(libraryBody(changedSkills)),
  });
  assert.equal(changed.response.status, 200);
  const finalWorkspace = await call("/api/workspace", {}, cookie);
  assert.ok(finalWorkspace.body.skills.some((skill: any) => skill.name === "independent"));
  assert.ok(!finalWorkspace.body.skills.some((skill: any) => skill.name === "beta"));
  assert.deepEqual(finalWorkspace.body.librarySource.excludedSkills, ["beta"]);
  assert.equal(finalWorkspace.body.skills.find((skill: any) => skill.name === "alpha").versions.length, 2);

  const otherWorkspace = await call("/api/workspace", {}, otherCookie);
  assert.equal(otherWorkspace.body.librarySource, undefined);
  assert.equal(otherWorkspace.body.skills.length, 0);

  const unlinked = await call("/api/device/library/unlink", {
    method: "POST",
    headers: owner.headers,
    body: "{}",
  });
  assert.equal(unlinked.body.unlinked, true);
  const retained = await call("/api/workspace", {}, cookie);
  assert.equal(retained.body.librarySource, undefined);
  assert.ok(retained.body.skills.every((skill: any) => !skill.librarySourceId));
  assert.ok(retained.body.skills.some((skill: any) => skill.name === "alpha"));

  const relinked = await call("/api/device/library", {
    method: "POST",
    headers: owner.headers,
    body: JSON.stringify(libraryBody([novaSkill("alpha", "Third")])),
  });
  assert.equal(relinked.response.status, 200);
  const browserUnlink = await post("/api/library/unlink", {}, cookie);
  assert.equal(browserUnlink.body.unlinked, true);
  const browserRetained = await call("/api/workspace", {}, cookie);
  assert.equal(browserRetained.body.librarySource, undefined);
  assert.ok(browserRetained.body.skills.find((skill: any) => skill.name === "alpha"));
});

test("source ingestion accepts long descriptions without weakening custom publishing", async () => {
  const cookie = await register("long-source-description@example.com");
  const device = await connectDevice(cookie, "Long description source");
  const description = "Detailed upstream guidance. ".repeat(80);
  assert.ok(description.length > 1024 && description.length < 16_384);
  const files = [
    {
      path: "SKILL.md",
      content: `---\nname: long-description\ndescription: ${description}\n---\n\n# Source\n`,
    },
  ];
  const skills: LibrarySnapshotSkill[] = [
    {
      name: "long-description",
      title: "Long description",
      source: "nova:skills/long-description",
      kind: "custom",
      files,
    },
  ];
  const body = libraryBody(skills);
  const accepted = await call("/api/device/library", {
    method: "POST",
    headers: device.headers,
    body: JSON.stringify(body),
  });
  assert.equal(accepted.response.status, 200);
  assert.equal(accepted.body.revision, body.revision);
  const workspace = await call("/api/workspace", {}, cookie);
  const imported = workspace.body.skills.find(
    (skill: any) => skill.name === "long-description",
  );
  assert.equal(imported.files[0].content, files[0].content);
  assert.equal(imported.description, description.trim());

  const custom = await post(
    "/api/skills",
    {
      title: "Custom long description",
      name: "custom-long-description",
      description: "Draft",
      files: [
        {
          path: "SKILL.md",
          content: `---\nname: custom-long-description\ndescription: ${description}\n---\n`,
        },
      ],
    },
    cookie,
  );
  assert.equal(custom.response.status, 200);
  const rejected = await post(
    `/api/skills/${custom.body.id}/publish`,
    { files: custom.body.draft },
    cookie,
  );
  assert.equal(rejected.response.status, 400);
  assert.match(rejected.body.error, /1–1024 characters/);
});

test("device authorization is account-bound, single-use, and receipts drive state", async () => {
  const cookie = await register("device-owner@example.com");
  const auth = await post("/api/device/authorize", {
    name: "Test laptop",
    os: "linux",
    arch: "x64",
  });
  const pending = await post("/api/device/token", {
    deviceCode: auth.body.deviceCode,
  });
  assert.equal(pending.response.status, 428);
  const approval = await post(
    "/api/device/approve",
    { userCode: auth.body.userCode },
    cookie,
  );
  assert.equal(approval.response.status, 200);
  const tokenResult = await post("/api/device/token", {
    deviceCode: auth.body.deviceCode,
  });
  assert.equal(tokenResult.response.status, 200);
  const repeated = await post("/api/device/token", {
    deviceCode: auth.body.deviceCode,
  });
  assert.equal(repeated.response.status, 403);
  const bearer = { authorization: `Bearer ${tokenResult.body.token}` };
  const heartbeat = await call("/api/device/heartbeat", {
    method: "POST",
    headers: bearer,
    body: JSON.stringify({
      name: "Renamed laptop",
      os: "linux",
      arch: "x64",
      agents: [{ id: "codex", name: "Codex", path: "/tmp/skills" }],
    }),
  });
  assert.equal(heartbeat.response.status, 200);
  const desired = await call("/api/device/desired", { headers: bearer });
  const receipts = await call("/api/device/receipts", {
    method: "POST",
    headers: bearer,
    body: JSON.stringify({
      generation: desired.body.generation,
      receipts: [
        {
          skillId: "none",
          agent: "codex",
          revision: "r1",
          status: "synchronized",
          timestamp: new Date().toISOString(),
        },
      ],
    }),
  });
  assert.equal(receipts.response.status, 200);
  const workspace = await call("/api/workspace", {}, cookie);
  assert.equal(workspace.body.devices[0].name, "Renamed laptop");
  assert.equal(workspace.body.devices[0].receipts[0].status, "synchronized");
  const arbitraryConflict = await call("/api/device/receipts", {
    method: "POST",
    headers: bearer,
    body: JSON.stringify({
      generation: desired.body.generation,
      receipts: [
        {
          skillId: "preexisting",
          agent: "codex",
          revision: "",
          status: "conflicted",
          timestamp: new Date().toISOString(),
          localFiles: [{ path: "notes.txt", content: "not a skill yet" }],
        },
      ],
    }),
  });
  assert.equal(arbitraryConflict.response.status, 200);
  const disconnectRequested = await post(
    `/api/devices/${tokenResult.body.deviceId}/disconnect`,
    { mode: "retain" },
    cookie,
  );
  assert.equal(disconnectRequested.response.status, 200);
  assert.equal(disconnectRequested.body.disconnect, "retain");
  assert.equal(disconnectRequested.body.disconnectedAt, undefined);
  const pendingDisconnect = await call("/api/device/desired", {
    headers: bearer,
  });
  assert.equal(pendingDisconnect.body.disconnect, "retain");
  const disconnected = await call("/api/device/disconnected", {
    method: "POST",
    headers: bearer,
    body: JSON.stringify({ mode: "retain" }),
  });
  assert.equal(disconnected.response.status, 200);
  const completedWorkspace = await call("/api/workspace", {}, cookie);
  const completedDevice = completedWorkspace.body.devices.find(
    (device: any) => device.id === tokenResult.body.deviceId,
  );
  assert.equal(completedDevice.online, false);
  assert.ok(!Number.isNaN(Date.parse(completedDevice.disconnectedAt)));
  const revoked = await call("/api/device/desired", { headers: bearer });
  assert.equal(revoked.response.status, 401);
  const requestedAgain = await post(
    `/api/devices/${tokenResult.body.deviceId}/disconnect`,
    { mode: "remove" },
    cookie,
  );
  assert.equal(requestedAgain.body.disconnectedAt, undefined);
});

test("target exceptions remain overrides, stale receipts do not sync, and import consumes a conflict", async () => {
  const cookie = await register("conflicts@example.com");
  const files = [
    {
      path: "SKILL.md",
      content:
        "---\nname: shared\ndescription: Shared published skill\n---\n\n# Shared\n",
    },
  ];
  const draft = await post(
    "/api/skills",
    { title: "Shared", name: "shared", description: "Shared", files },
    cookie,
  );
  const published = await post(
    `/api/skills/${draft.body.id}/publish`,
    {},
    cookie,
  );
  const auth = await post("/api/device/authorize", {
    name: "Conflict client",
    os: "linux",
    arch: "x64",
  });
  await post("/api/device/approve", { userCode: auth.body.userCode }, cookie);
  const token = await post("/api/device/token", {
    deviceCode: auth.body.deviceCode,
  });
  const headers = { authorization: `Bearer ${token.body.token}` };
  await call("/api/device/heartbeat", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Conflict client",
      os: "linux",
      arch: "x64",
      agents: [
        { id: "codex", name: "Codex", path: "/codex" },
        { id: "claude", name: "Claude", path: "/claude" },
      ],
    }),
  });
  await call(
    `/api/skills/${published.body.id}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targets: [
          { deviceId: token.body.deviceId, agent: "codex", enabled: false },
        ],
      }),
    },
    cookie,
  );
  const desired = await call("/api/device/desired", { headers });
  assert.equal(desired.body.skills[0].targets[0].enabled, false);
  const secondAuth = await post("/api/device/authorize", {
    name: "Second client",
    os: "linux",
    arch: "x64",
  });
  await post(
    "/api/device/approve",
    { userCode: secondAuth.body.userCode },
    cookie,
  );
  const secondToken = await post("/api/device/token", {
    deviceCode: secondAuth.body.deviceCode,
  });
  const secondHeaders = { authorization: `Bearer ${secondToken.body.token}` };
  await call("/api/device/heartbeat", {
    method: "POST",
    headers: secondHeaders,
    body: JSON.stringify({
      name: "Second client",
      os: "linux",
      arch: "x64",
      agents: [{ id: "codex", name: "Codex", path: "/second" }],
    }),
  });
  const secondDesired = await call("/api/device/desired", {
    headers: secondHeaders,
  });
  assert.equal(secondDesired.body.skills.length, 1);
  assert.deepEqual(secondDesired.body.skills[0].targets, []);
  await call("/api/device/receipts", {
    method: "POST",
    headers,
    body: JSON.stringify({
      generation: desired.body.generation - 1,
      receipts: [
        {
          skillId: published.body.id,
          agent: "claude",
          revision: published.body.revision,
          status: "synchronized",
          timestamp: new Date().toISOString(),
        },
      ],
    }),
  });
  let workspace = await call("/api/workspace", {}, cookie);
  assert.equal(workspace.body.devices[0].lastSync, undefined);
  await post(
    `/api/devices/${token.body.deviceId}/resolve`,
    {
      skillId: published.body.id,
      agent: "claude",
      profile: "work",
      project: "/project",
      action: "import",
    },
    cookie,
  );
  await call(`/api/skills/${published.body.id}`, { method: "DELETE" }, cookie);
  const afterRemoval = await call("/api/workspace", {}, cookie);
  const localFiles = [
    {
      path: "SKILL.md",
      content:
        "---\nname: shared\ndescription: Locally edited skill\n---\n\n# Local\n",
    },
  ];
  await call("/api/device/receipts", {
    method: "POST",
    headers,
    body: JSON.stringify({
      generation: afterRemoval.body.generation,
      receipts: [
        {
          skillId: published.body.id,
          agent: "claude",
          profile: "work",
          project: "/project",
          revision: "local-change",
          status: "conflicted",
          timestamp: new Date().toISOString(),
          localFiles,
        },
      ],
    }),
  });
  workspace = await call("/api/workspace", {}, cookie);
  const imported = workspace.body.skills.find(
    (skill: any) => skill.name === "shared-local",
  );
  assert.ok(imported);
  assert.equal(imported.revision, "");
  assert.match(imported.draft[0].content, /name: shared-local/);
  assert.match(imported.draft[0].content, /# Local/);
  assert.equal(
    workspace.body.devices[0].resolutions[
      `${published.body.id}:claude:work:/project`
    ],
    undefined,
  );
  assert.equal(workspace.body.activity[0].status, "conflicted");
  await call("/api/device/receipts", {
    method: "POST",
    headers,
    body: JSON.stringify({
      generation: workspace.body.generation,
      receipts: [
        {
          skillId: published.body.id,
          agent: "claude",
          profile: "work",
          project: "/project",
          revision: "local-change",
          status: "conflicted",
          timestamp: new Date().toISOString(),
          localFiles,
        },
      ],
    }),
  });
  workspace = await call("/api/workspace", {}, cookie);
  assert.equal(
    workspace.body.skills.filter((skill: any) =>
      skill.name.startsWith("shared-local"),
    ).length,
    1,
  );
  const brokenFiles = [
    { path: "SKILL.md", content: "# broken metadata\n" },
    { path: "notes.txt", content: "recover me" },
  ];
  const reportBroken = async () =>
    call("/api/device/receipts", {
      method: "POST",
      headers,
      body: JSON.stringify({
        generation: workspace.body.generation,
        receipts: [
          {
            skillId: "deleted-broken",
            agent: "claude",
            revision: "",
            status: "conflicted",
            timestamp: new Date().toISOString(),
            localFiles: brokenFiles,
          },
        ],
      }),
    });
  await reportBroken();
  await post(
    `/api/devices/${token.body.deviceId}/resolve`,
    { skillId: "deleted-broken", agent: "claude", action: "import" },
    cookie,
  );
  workspace = await call("/api/workspace", {}, cookie);
  await reportBroken();
  workspace = await call("/api/workspace", {}, cookie);
  assert.deepEqual(
    workspace.body.skills.find(
      (skill: any) => skill.name === "imported-skill-local",
    ).draft,
    brokenFiles,
  );
  const longName = "a".repeat(64);
  const longFiles = [
    {
      path: "SKILL.md",
      content: `---\nname: ${longName}\ndescription: Long local skill\n---\n`,
    },
  ];
  const reportLong = async () =>
    call("/api/device/receipts", {
      method: "POST",
      headers,
      body: JSON.stringify({
        generation: workspace.body.generation,
        receipts: [
          {
            skillId: "deleted-long",
            agent: "claude",
            revision: "",
            status: "conflicted",
            timestamp: new Date().toISOString(),
            localFiles: longFiles,
          },
        ],
      }),
    });
  await reportLong();
  await post(
    `/api/devices/${token.body.deviceId}/resolve`,
    { skillId: "deleted-long", agent: "claude", action: "import" },
    cookie,
  );
  workspace = await call("/api/workspace", {}, cookie);
  await reportLong();
  workspace = await call("/api/workspace", {}, cookie);
  assert.equal(workspace.body.skills.at(-1).name.length, 64);
  const emptyDesired = await call("/api/device/desired", { headers });
  await call("/api/device/receipts", {
    method: "POST",
    headers,
    body: JSON.stringify({
      generation: emptyDesired.body.generation,
      receipts: [],
    }),
  });
  workspace = await call("/api/workspace", {}, cookie);
  assert.ok(
    workspace.body.devices.find(
      (device: any) => device.id === token.body.deviceId,
    ).lastSync,
  );
});

test("private sources resolve once on a connected device without exposing credentials", async () => {
  const cookie = await register("private-source@example.com");
  const queued = await post(
    "/api/skills/install",
    { source: "./private-repository", name: "private-skill" },
    cookie,
  );
  assert.equal(queued.response.status, 202);
  assert.equal(queued.body.pending, true);
  const authorization = await post("/api/device/authorize", {
    name: "Private source device",
    os: "linux",
    arch: "x64",
  });
  await post(
    "/api/device/approve",
    { userCode: authorization.body.userCode },
    cookie,
  );
  const connected = await post("/api/device/token", {
    deviceCode: authorization.body.deviceCode,
  });
  const bearer = { authorization: `Bearer ${connected.body.token}` };
  const desired = await call("/api/device/desired", { headers: bearer });
  assert.equal(desired.body.sourceRequests[0].id, queued.body.id);
  const files = [
    {
      path: "SKILL.md",
      content:
        "---\nname: private-skill\ndescription: Private device-resolved skill\n---\n",
    },
  ];
  const resolved = {
    name: "private-skill",
    title: "Private skill",
    description: "Private device-resolved skill",
    author: "Private",
    source: "./private-repository",
    category: "Development",
    icon: "code",
    color: "blue",
    revision: "private-r1",
    files,
    requirements: [],
  };
  const accepted = await call("/api/device/source", {
    method: "POST",
    headers: { ...bearer, "content-type": "application/json" },
    body: JSON.stringify({ requestId: queued.body.id, resolved }),
  });
  assert.equal(accepted.body.accepted, true);
  const repeated = await call("/api/device/source", {
    method: "POST",
    headers: { ...bearer, "content-type": "application/json" },
    body: JSON.stringify({ requestId: queued.body.id, resolved }),
  });
  assert.equal(repeated.body.accepted, false);
  const workspace = await call("/api/workspace", {}, cookie);
  assert.equal(workspace.body.sourceRequests.length, 0);
  assert.equal(
    workspace.body.skills.find((skill: any) => skill.name === "private-skill")
      .revision,
    "private-r1",
  );
});
