import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { createApp } from "../server/app.ts";
import { demoCatalog } from "../server/catalog.ts";

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
  const disconnected = await call("/api/device/disconnected", {
    method: "POST",
    headers: bearer,
    body: JSON.stringify({ mode: "retain" }),
  });
  assert.equal(disconnected.response.status, 200);
  const revoked = await call("/api/device/desired", { headers: bearer });
  assert.equal(revoked.response.status, 401);
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
