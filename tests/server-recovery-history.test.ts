import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { unzipSync } from "fflate";
import { createApp } from "../server/app.ts";

test("device recovery archives local files without changing desired state", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "equip-recovery-history-"));
  const { app, close } = await createApp({ dataDir, autoUpdateIntervalMs: 0 });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let cookie = "";
  const call = async (route: string, method = "GET", body?: unknown, token?: string) => {
    const response = await fetch(base + route, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    cookie = response.headers.get("set-cookie")?.split(";")[0] ?? cookie;
    const contentType = response.headers.get("content-type") ?? "";
    return {
      response,
      body: contentType.includes("application/json") ? await response.json() : new Uint8Array(await response.arrayBuffer()),
    };
  };
  const connect = async (name: string) => {
    const authorization = await call("/api/device/authorize", "POST", { name, os: "linux", arch: "x64" });
    await call("/api/device/approve", "POST", { userCode: authorization.body.userCode });
    const connected = await call("/api/device/token", "POST", { deviceCode: authorization.body.deviceCode });
    return connected.body.token as string;
  };

  try {
    await call("/api/auth/register", "POST", {
      name: "Recovery owner",
      email: "recovery-owner@example.com",
      password: "correct horse battery",
    });
    const currentFiles = [{
      path: "SKILL.md",
      content: "---\nname: recovered-skill\ndescription: Current copy\n---\n\nCurrent\n",
    }];
    const created = await call("/api/skills", "POST", {
      title: "Recovered skill",
      name: "recovered-skill",
      description: "Current copy",
      files: currentFiles,
    });
    await call(`/api/skills/${created.body.id}/publish`, "POST", { files: currentFiles });
    const instructions = await call("/api/instructions", "POST", {
      title: "Global instructions",
      filename: "AGENTS.md",
      scope: "global",
      files: [{ path: "AGENTS.md", content: "Current instructions\n" }],
    });
    const publishedInstructions = await call(`/api/instructions/${instructions.body.id}/publish`, "POST", {
      files: [{ path: "AGENTS.md", content: "Current instructions\n" }],
    });
    const token = await connect("Recovery laptop");
    const desiredBefore = await call("/api/device/desired", "GET", undefined, token);
    const workspaceBefore = await call("/api/workspace");
    const selected = workspaceBefore.body.skills[0];

    const recoveredFiles = [
      { path: "SKILL.md", content: "damaged frontmatter retained\n" },
      { path: "notes/local.txt", content: "local work\n", mode: 0o600 },
    ];
    const unauthenticated = await fetch(base + "/api/device/recovery", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skillId: selected.id, files: recoveredFiles }),
    });
    assert.equal(unauthenticated.status, 401);

    const recovered = await call("/api/device/recovery", "POST", {
      skillId: selected.id,
      files: recoveredFiles,
      path: "/home/recovery/.codex/skills/recovered-skill",
    }, token);
    assert.equal(recovered.response.status, 200);
    assert.equal(recovered.body.id, selected.id);
    assert.equal(recovered.body.archived, true);
    const duplicate = await call("/api/device/recovery", "POST", {
      skillId: selected.id,
      files: recoveredFiles,
      path: "/home/recovery/.codex/skills/recovered-skill",
    }, token);
    assert.deepEqual(duplicate.body, recovered.body);

    const instructionRecovery = await call("/api/device/recovery", "POST", {
      skillId: instructions.body.id,
      kind: "instructions",
      files: [{ path: "CLAUDE.md", content: "Recovered instructions\n" }],
      path: "/home/recovery/.claude/CLAUDE.md",
    }, token);
    assert.equal(instructionRecovery.response.status, 200);
    const unsafe = await call("/api/device/recovery", "POST", {
      skillId: selected.id,
      files: [{ path: "../escape", content: "no" }],
    }, token);
    assert.equal(unsafe.response.status, 400);

    const workspaceAfter = await call("/api/workspace");
    const skillAfter = workspaceAfter.body.skills[0];
    const instructionsAfter = workspaceAfter.body.instructions[0];
    assert.equal(workspaceAfter.body.generation, workspaceBefore.body.generation);
    assert.equal(skillAfter.revision, selected.revision);
    assert.deepEqual(skillAfter.files, selected.files);
    assert.deepEqual(skillAfter.targets, selected.targets);
    assert.equal(skillAfter.autoUpdate, selected.autoUpdate);
    assert.equal(skillAfter.versions[0].revision, selected.revision);
    assert.equal(skillAfter.versions.length, selected.versions.length + 1);
    assert.match(skillAfter.versions[1].message, /Recovery laptop.*\/home\/recovery/);
    assert.equal(instructionsAfter.revision, publishedInstructions.body.revision);
    assert.equal(instructionsAfter.versions.length, publishedInstructions.body.versions.length + 1);
    assert.equal(instructionsAfter.versions[1].files[0].path, "AGENTS.md");

    const desiredAfter = await call("/api/device/desired", "GET", undefined, token);
    assert.deepEqual(desiredAfter.body, desiredBefore.body);
    const damagedExport = await call(`/api/skills/${selected.id}/export?revision=${recovered.body.revision}`);
    assert.equal(damagedExport.response.status, 200);
    assert.equal(Buffer.from(unzipSync(damagedExport.body)["recovered-skill/SKILL.md"]!).toString(), recoveredFiles[0].content);

    const validRecoveredFiles = [{
      path: "SKILL.md",
      content: "---\nname: recovered-skill\ndescription: Archived valid copy\n---\n\nArchived\n",
    }];
    const validRecovery = await call("/api/device/recovery", "POST", {
      skillId: selected.id,
      files: validRecoveredFiles,
    }, token);
    const exported = await call(`/api/skills/${selected.id}/export?revision=${validRecovery.body.revision}`);
    assert.equal(exported.response.status, 200);
    const archive = unzipSync(exported.body);
    assert.equal(Buffer.from(archive["recovered-skill/SKILL.md"]!).toString(), validRecoveredFiles[0].content);

    const ownerCookie = cookie;
    cookie = "";
    await call("/api/auth/register", "POST", {
      name: "Other account",
      email: "recovery-other@example.com",
      password: "correct horse battery",
    });
    const otherToken = await connect("Other laptop");
    const isolated = await call("/api/device/recovery", "POST", {
      skillId: selected.id,
      files: validRecoveredFiles,
    }, otherToken);
    assert.equal(isolated.response.status, 404);
    cookie = ownerCookie;
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
