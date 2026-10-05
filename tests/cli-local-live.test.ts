import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createApp } from "../server/app.ts";

async function runCli(args: string[], environment: Record<string, string>, approve?: (code: string) => Promise<void>) {
  const child = spawn(process.execPath, ["--import", "tsx", "cli/index.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let approved = false;
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
    const code = output.match(/Code: ([A-Z0-9-]+)/)?.[1];
    if (code && approve && !approved) {
      approved = true;
      void approve(code);
    }
  });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const exit = await new Promise<number | null>((done, reject) => {
    child.once("exit", done);
    child.once("error", reject);
  });
  assert.equal(exit, 0, output);
  return output;
}

test("local folders publish through one device and synchronize as canonical links on both devices", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "equip-local-live-"));
  const { app, close } = await createApp({ dataDir: join(root, "server"), autoUpdateIntervalMs: 0 });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((done) => listener.once("listening", done));
  const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const registration = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Local live", email: `local-${Date.now()}@example.com`, password: "test-password-123" }),
  });
  assert.equal(registration.status, 201);
  const cookie = registration.headers.get("set-cookie")!.split(";")[0];
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", cookie, ...init.headers } });
    const body = await response.json();
    assert.ok(response.ok, `${response.status} ${JSON.stringify(body)}`);
    return body as any;
  };
  const clients = ["one", "two"].map((label) => ({
    label,
    home: join(root, label, "equip"),
    targets: [join(root, label, "codex"), join(root, label, "claude")],
  }));
  try {
    for (const client of clients) {
      const environment = {
        EQUIP_HOME: client.home,
        EQUIP_AGENT_HOME: join(root, client.label, "agent-home"),
        EQUIP_SKILLS_ROOT: resolve("node_modules/skills"),
        EQUIP_NO_SERVICE: "1",
      };
      await runCli(["connect", "--headless", "--once", "--server", base], environment, async (userCode) => {
        const response = await fetch(`${base}/api/device/approve`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ userCode }),
        });
        assert.equal(response.status, 200);
      });
      const statePath = join(client.home, "state.json");
      const state = JSON.parse(await readFile(statePath, "utf8"));
      state.autoDetect = false;
      state.targets = [
        { id: "codex", path: client.targets[0], profile: "default" },
        { id: "claude-code", path: client.targets[1], profile: "work" },
      ];
      await writeFile(statePath, JSON.stringify(state, null, 2));
      (client as any).environment = environment;
      (client as any).deviceId = state.deviceId;
    }

    await request(`/api/devices/${(clients[0] as any).deviceId}/local-sync`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: true }),
    });
    const skillRoot = join(clients[0].home, "skills/foo");
    const initial = "---\nname: foo\ndescription: Local integration fixture\n---\n\n# Initial\n";
    await mkdir(join(skillRoot, "scripts"), { recursive: true });
    await writeFile(join(skillRoot, "SKILL.md"), initial);
    await writeFile(join(skillRoot, "scripts/data.bin"), Buffer.from([0xff, 0x00, 0x7f]));
    await writeFile(join(skillRoot, "scripts/run.sh"), "#!/bin/sh\nexit 0\n");
    await chmod(join(skillRoot, "scripts/run.sh"), 0o755);

    await runCli(["sync"], (clients[0] as any).environment);
    await runCli(["sync"], (clients[1] as any).environment);
    for (const client of clients) {
      for (const target of client.targets) {
        assert.equal((await lstat(join(target, "foo"))).isSymbolicLink(), true);
        assert.equal(await readFile(join(target, "foo/SKILL.md"), "utf8"), initial);
      }
      const canonical = await import("node:fs/promises").then((fs) => fs.realpath(join(client.home, "skills/foo")));
      for (const target of client.targets)
        assert.equal(await import("node:fs/promises").then((fs) => fs.realpath(join(target, "foo"))), canonical);
      assert.equal((await stat(join(client.home, "skills/foo/scripts/run.sh"))).mode & 0o777, 0o755);
      assert.deepEqual(await readFile(join(client.home, "skills/foo/scripts/data.bin")), Buffer.from([0xff, 0x00, 0x7f]));
    }

    let workspace = await request("/api/workspace");
    let published = workspace.skills.find((skill: any) => skill.name === "foo");
    assert.ok(published?.localOrigin);
    const dashboard = initial.replace("# Initial", "# Dashboard");
    const dashboardFiles = published.files.map((file: any) => file.path === "SKILL.md" ? { ...file, content: dashboard } : file);
    published = await request(`/api/skills/${published.id}/publish`, {
      method: "POST",
      body: JSON.stringify({ files: dashboardFiles, message: "Dashboard edit" }),
    });
    await runCli(["sync"], (clients[0] as any).environment);
    await runCli(["sync"], (clients[1] as any).environment);
    assert.equal(await readFile(join(clients[0].home, "skills/foo/SKILL.md"), "utf8"), dashboard);
    assert.equal(await readFile(join(clients[1].home, "skills/foo/SKILL.md"), "utf8"), dashboard);

    // An edit immediately after receiving a dashboard update uses that newly
    // installed revision, without requiring an extra settling sync.
    const localEdit = dashboard.replace("# Dashboard", "# Device one");
    await writeFile(join(clients[0].home, "skills/foo/SKILL.md"), localEdit);
    await runCli(["sync"], (clients[0] as any).environment);
    await runCli(["sync"], (clients[1] as any).environment);
    assert.equal(await readFile(join(clients[1].home, "skills/foo/SKILL.md"), "utf8"), localEdit);
    workspace = await request("/api/workspace");
    assert.equal(workspace.skills.find((skill: any) => skill.name === "foo").files.find((file: any) => file.path === "SKILL.md").content, localEdit);

    await request(`/api/devices/${(clients[1] as any).deviceId}/local-sync`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: true }),
    });
    await runCli(["sync"], (clients[1] as any).environment);
    const winner = localEdit.replace("# Device one", "# First publisher");
    const collision = localEdit.replace("# Device one", "# Concurrent publisher");
    await writeFile(join(clients[0].home, "skills/foo/SKILL.md"), winner);
    await writeFile(join(clients[1].home, "skills/foo/SKILL.md"), collision);
    await runCli(["sync"], (clients[0] as any).environment);
    await runCli(["sync"], (clients[1] as any).environment);
    workspace = await request("/api/workspace");
    published = workspace.skills.find((skill: any) => skill.name === "foo");
    assert.equal(published.files.find((file: any) => file.path === "SKILL.md").content, winner);
    assert.equal(await readFile(join(clients[1].home, "skills/foo/SKILL.md"), "utf8"), collision);

    await request(`/api/devices/${(clients[0] as any).deviceId}/local-sync`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });
    const blocked = join(clients[0].home, "skills/blocked");
    await mkdir(blocked);
    await writeFile(join(blocked, "SKILL.md"), "---\nname: blocked\ndescription: Must stay local\n---\n");
    await runCli(["sync"], (clients[0] as any).environment);
    workspace = await request("/api/workspace");
    assert.equal(workspace.skills.some((skill: any) => skill.name === "blocked"), false);
    assert.equal(await readFile(join(blocked, "SKILL.md"), "utf8"), "---\nname: blocked\ndescription: Must stay local\n---\n");
    const explicit = await runCli(["local", "add", blocked], (clients[0] as any).environment);
    assert.match(explicit, /Published blocked/);
    workspace = await request("/api/workspace");
    assert.equal(workspace.skills.some((skill: any) => skill.name === "blocked"), true);

    await request(`/api/devices/${(clients[1] as any).deviceId}/local-sync`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });
    await request(`/api/skills/${published.id}`, { method: "DELETE" });
    await runCli(["sync"], (clients[0] as any).environment);
    workspace = await request("/api/workspace");
    assert.equal(workspace.skills.some((skill: any) => skill.name === "foo"), false);
    assert.equal(await readFile(join(clients[0].home, "skills/foo/SKILL.md"), "utf8"), winner);
  } finally {
    await new Promise<void>((done) => listener.close(() => done()));
    await close();
    await rm(root, { recursive: true, force: true });
  }
});
