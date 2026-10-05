import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createApp } from "../server/app.ts";
import { readLibrarySnapshot } from "../cli/library.ts";

async function runCli(args: string[], environment: Record<string, string>, approve?: (code: string) => Promise<void>) {
  const child = spawn(process.execPath, ["--import", "tsx", "cli/index.ts", ...args], {
    cwd: process.cwd(), env: { ...process.env, ...environment }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let approved = false;
  child.stdout.on("data", chunk => {
    output += chunk.toString();
    const code = output.match(/Code: ([A-Z0-9-]+)/)?.[1];
    if (code && approve && !approved) { approved = true; void approve(code); }
  });
  child.stderr.on("data", chunk => { output += chunk.toString(); });
  const exit = await new Promise<number | null>((done, reject) => {
    child.once("exit", done);
    child.once("error", reject);
  });
  assert.equal(exit, 0, output);
  return output;
}

test("folder import is a one-time copy managed centrally by Equip", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "equip-library-import-"));
  const { app, close } = await createApp({ dataDir: join(root, "server"), autoUpdateIntervalMs: 0 });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>(done => listener.once("listening", done));
  const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const equipHome = join(root, "client");
  const source = join(root, "nova");
  const skillRoot = join(source, "skills", "nova-owned");
  const targetOne = join(root, "target-one");
  const targetTwo = join(root, "target-two");
  const first = "---\nname: nova-owned\ndescription: Imported\n---\n\n# Imported\n";
  const sourceEdit = "---\nname: nova-owned\ndescription: Source edit\n---\n\n# Source edit\n";
  const dashboardEdit = "---\nname: nova-owned\ndescription: Equip edit\n---\n\n# Equip edit\n";
  try {
    await mkdir(skillRoot, { recursive: true });
    await mkdir(targetOne, { recursive: true });
    await mkdir(targetTwo, { recursive: true });
    await writeFile(join(source, "skills", "skills-sh.json"), "{}\n");
    await writeFile(join(skillRoot, "SKILL.md"), first);
    const reference = "Complete skill payload.\n".repeat(65_000);
    await writeFile(join(skillRoot, "reference.txt"), reference);
    const registration = await fetch(`${base}/api/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Import integration", email: `import-${Date.now()}@example.com`, password: "test-password-123" }),
    });
    assert.equal(registration.status, 201);
    const cookie = registration.headers.get("set-cookie")!.split(";")[0];
    const environment = {
      EQUIP_HOME: equipHome, EQUIP_AGENT_HOME: join(root, "agent-home"),
      EQUIP_SKILLS_ROOT: resolve("node_modules/skills"), EQUIP_NO_SERVICE: "1",
    };
    await runCli(["connect", "--headless", "--once", "--server", base], environment, async userCode => {
      const response = await fetch(`${base}/api/device/approve`, {
        method: "POST", headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ userCode }),
      });
      assert.equal(response.status, 200);
    });
    const statePath = join(equipHome, "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.autoDetect = false;
    state.targets = [
      { id: "codex", name: "Codex", path: targetOne, profile: "default" },
      { id: "claude-code", name: "Claude Code", path: targetTwo, profile: "work" },
    ];
    await writeFile(statePath, JSON.stringify(state, null, 2));

    const imported = await runCli(["library", "import", source, "--name", "Nova"], environment);
    assert.match(imported, /Nova imported\. 1 skill\(s\) copied to Equip/);
    assert.equal(await readFile(join(targetOne, "nova-owned", "SKILL.md"), "utf8"), first);
    assert.equal(await readFile(join(targetTwo, "nova-owned", "reference.txt"), "utf8"), reference);

    await writeFile(join(skillRoot, "SKILL.md"), sourceEdit);
    await runCli(["sync"], environment);
    assert.equal(await readFile(join(targetOne, "nova-owned", "SKILL.md"), "utf8"), first);

    let workspace = await fetch(`${base}/api/workspace`, { headers: { cookie } }).then(response => response.json()) as any;
    const skill = workspace.skills.find((item: any) => item.name === "nova-owned");
    const publish = await fetch(`${base}/api/skills/${skill.id}/publish`, {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ files: skill.files.map((file: any) => file.path === "SKILL.md" ? { ...file, content: dashboardEdit } : file) }),
    });
    assert.equal(publish.status, 200);
    const centralRevision = (await publish.json() as any).revision;
    await runCli(["sync"], environment);
    assert.equal(await readFile(join(targetOne, "nova-owned", "SKILL.md"), "utf8"), dashboardEdit);
    assert.equal(await readFile(join(targetTwo, "nova-owned", "SKILL.md"), "utf8"), dashboardEdit);
    assert.equal(await readFile(join(skillRoot, "SKILL.md"), "utf8"), sourceEdit);
    const ledger = JSON.parse(await readFile(join(equipHome, "ledger.json"), "utf8"));
    assert.ok(Object.values(ledger.installs).every((entry: any) => entry.revision === centralRevision));

    const removed = await fetch(`${base}/api/skills/${skill.id}`, { method: "DELETE", headers: { cookie } });
    assert.equal(removed.status, 200);
    await runCli(["sync"], environment);
    workspace = await fetch(`${base}/api/workspace`, { headers: { cookie } }).then(response => response.json()) as any;
    assert.equal(workspace.skills.some((item: any) => item.name === "nova-owned"), false);

    const snapshot = await readLibrarySnapshot(source);
    const stale = await fetch(`${base}/api/device/library`, {
      method: "POST", headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json" },
      body: JSON.stringify({ id: "nova", name: "Nova", expectedRevision: snapshot.revision, ...snapshot }),
    });
    assert.equal(stale.status, 409);
  } finally {
    await new Promise<void>(done => listener.close(() => done()));
    await close();
    await rm(root, { recursive: true, force: true });
  }
});
