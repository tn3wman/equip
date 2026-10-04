import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../server/app.ts";

const skillFiles = (name: string, body: string) => [{
  path: "SKILL.md",
  content: `---\nname: ${name}\ndescription: Concurrent ${name}\n---\n\n${body}\n`,
}];

test("two app instances serialize workspace mutations without losing skills or heartbeats", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "equip-server-concurrency-"));
  let releaseResolve!: () => void;
  let markResolverEntered!: () => void;
  const resolverEntered = new Promise<void>(resolve => { markResolverEntered = resolve; });
  const resolverRelease = new Promise<void>(resolve => { releaseResolve = resolve; });
  const first = await createApp({
    dataDir,
    autoUpdateIntervalMs: 0,
    sourceResolver: async () => {
      markResolverEntered();
      await resolverRelease;
      return { name: "aborted-source", title: "Aborted source", description: "Resolved after disconnect",
        author: "test", source: "example/source", revision: "source-revision", files: skillFiles("aborted-source", "Resolved") };
    },
    safetyResolver: async () => ({ status: "pass", audits: [], checkedAt: new Date(0).toISOString(), scope: "upstream" }),
  });
  const second = await createApp({ dataDir, autoUpdateIntervalMs: 0 });
  const servers = [first.app.listen(0, "127.0.0.1"), second.app.listen(0, "127.0.0.1")];
  await Promise.all(servers.map(server => new Promise<void>(resolve => server.once("listening", resolve))));
  const bases = servers.map(server => `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  let cookie = "";
  const call = async (instance: number, route: string, method = "GET", body?: unknown, token?: string, signal?: AbortSignal) => {
    const response = await fetch(bases[instance] + route, {
      method, signal,
      headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    cookie = response.headers.get("set-cookie")?.split(";")[0] ?? cookie;
    const contentType = response.headers.get("content-type") ?? "";
    return { response, body: contentType.includes("application/json") ? await response.json() : await response.text() };
  };
  try {
    assert.equal((await call(0, "/api/auth/register", "POST", {
      name: "Concurrent owner", email: "concurrent@example.test", password: "correct horse battery",
    })).response.status, 201);
    const authorization = await call(0, "/api/device/authorize", "POST", { name: "Laptop", os: "linux", arch: "x64" });
    await call(0, "/api/device/approve", "POST", { userCode: authorization.body.userCode });
    const connected = await call(1, "/api/device/token", "POST", { deviceCode: authorization.body.deviceCode });
    const token = connected.body.token as string;

    const [alpha, beta] = await Promise.all([
      call(0, "/api/skills", "POST", { title: "Alpha", name: "alpha", description: "Alpha", files: skillFiles("alpha", "Draft") }),
      call(1, "/api/skills", "POST", { title: "Beta", name: "beta", description: "Beta", files: skillFiles("beta", "Draft") }),
    ]);
    assert.equal(alpha.response.status, 200);
    assert.equal(beta.response.status, 200);

    const [published, heartbeat] = await Promise.all([
      call(0, `/api/skills/${alpha.body.id}/publish`, "POST", { files: skillFiles("alpha", "Published") }),
      call(1, "/api/device/heartbeat", "POST", {
        name: "Renamed laptop", os: "linux", arch: "arm64",
        agents: [{ id: "codex", name: "Codex", path: "/tmp/concurrent-skills" }],
      }, token),
    ]);
    assert.equal(published.response.status, 200);
    assert.equal(heartbeat.response.status, 200);

    const workspace = await call(1, "/api/workspace");
    assert.deepEqual(workspace.body.skills.map((skill: any) => skill.name).sort(), ["alpha", "beta"]);
    assert.match(workspace.body.skills.find((skill: any) => skill.name === "alpha").files[0].content, /Published/);
    assert.equal(workspace.body.devices[0].name, "Renamed laptop");
    assert.equal(workspace.body.devices[0].arch, "arm64");
    assert.equal(workspace.body.devices[0].agents[0].id, "codex");

    const controller = new AbortController();
    const abandoned = call(0, "/api/skills/install", "POST", { source: "example/source" }, undefined, controller.signal);
    await resolverEntered;
    const duringWrite = await Promise.race([
      call(1, "/api/device/desired", "GET", undefined, token),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Desired state was blocked by an unrelated source download")), 1_000)),
    ]);
    assert.equal(duringWrite.response.status, 200);
    assert.ok(duringWrite.body.skills.some((skill: any) => skill.name === "alpha"));
    controller.abort();
    await assert.rejects(abandoned, /abort/i);
    releaseResolve();
    const afterAbort = await Promise.race([
      call(1, "/api/skills", "POST", { title: "After abort", name: "after-abort", description: "After abort", files: skillFiles("after-abort", "Draft") }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Account lock was not released after the client disconnected")), 2_000)),
    ]);
    assert.equal(afterAbort.response.status, 200);
    const finalWorkspace = await call(1, "/api/workspace");
    assert.ok(finalWorkspace.body.skills.some((skill: any) => skill.name === "after-abort"));
  } finally {
    releaseResolve?.();
    await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    await Promise.all([first.close(), second.close()]);
    await rm(dataDir, { recursive: true, force: true });
  }
});
