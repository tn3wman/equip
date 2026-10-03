import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createApp } from "../server/app.ts";
import { readNovaLibrary } from "../cli/library.ts";

async function runCli(
  args: string[],
  environment: Record<string, string>,
  approve?: (code: string) => Promise<void>,
) {
  const bundle = resolve("dist/equip.cjs");
  const bundled = existsSync(bundle);
  const child = spawn(
    process.execPath,
    bundled ? [bundle, ...args] : ["--import", "tsx", "cli/index.ts", ...args],
    {
      cwd: bundled ? tmpdir() : process.cwd(),
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
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
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  const exit = await new Promise<number | null>((done, reject) => {
    child.once("exit", done);
    child.once("error", reject);
  });
  assert.equal(exit, 0, output);
  return output;
}

test(
  "Nova continuously updates every configured target and dashboard unlink stops relinking",
  { timeout: 20_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "equip-nova-live-"));
    const { app, close } = await createApp({
      dataDir: join(root, "server"),
      autoUpdateIntervalMs: 0,
    });
    const listener = app.listen(0, "127.0.0.1");
    await new Promise<void>((done) => listener.once("listening", done));
    const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
    const equipHome = join(root, "client");
    const nova = join(root, "nova");
    const skillRoot = join(nova, "skills", "nova-owned");
    const targetOne = join(root, "target-one");
    const targetTwo = join(root, "target-two");
    const first = "---\nname: nova-owned\ndescription: First revision\n---\n\n# First\n";
    const second = "---\nname: nova-owned\ndescription: Second revision\n---\n\n# Second\n";
    const third = "---\nname: nova-owned\ndescription: Third revision\n---\n\n# Third\n";
    try {
      await mkdir(skillRoot, { recursive: true });
      await writeFile(join(nova, "skills", "skills-sh.json"), "{}\n");
      await writeFile(join(skillRoot, "SKILL.md"), first);
      await writeFile(join(skillRoot, "reference.txt"), "Complete skill payload.\n".repeat(65_000));
      const registration = await fetch(`${base}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Nova integration",
          email: `nova-live-${Date.now()}@example.com`,
          password: "test-password-123",
        }),
      });
      assert.equal(registration.status, 201);
      const cookie = registration.headers.get("set-cookie")!.split(";")[0];
      const environment = {
        EQUIP_HOME: equipHome,
        EQUIP_AGENT_HOME: join(root, "agent-home"),
        EQUIP_SKILLS_ROOT: resolve("node_modules/skills"),
        EQUIP_NO_SERVICE: "1",
      };
      await runCli(
        ["connect", "--headless", "--once", "--server", base],
        environment,
        async (userCode) => {
          const response = await fetch(`${base}/api/device/approve`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ userCode }),
          });
          assert.equal(response.status, 200);
        },
      );
      const statePath = join(equipHome, "state.json");
      const state = JSON.parse(await readFile(statePath, "utf8"));
      state.autoDetect = false;
      state.targets = [
        { id: "codex", name: "Codex", path: targetOne, profile: "default" },
        { id: "claude-code", name: "Claude Code", path: targetTwo, profile: "work" },
      ];
      await writeFile(statePath, JSON.stringify(state, null, 2));

      await runCli(["library", "connect", nova], environment);
      assert.equal(await readFile(join(targetOne, "nova-owned", "SKILL.md"), "utf8"), first);
      assert.equal(await readFile(join(targetTwo, "nova-owned", "SKILL.md"), "utf8"), first);

      await writeFile(join(skillRoot, "SKILL.md"), second);
      await runCli(["sync"], environment);
      assert.equal(await readFile(join(targetOne, "nova-owned", "SKILL.md"), "utf8"), second);
      assert.equal(await readFile(join(targetTwo, "nova-owned", "SKILL.md"), "utf8"), second);
      const workspaceResponse = await fetch(`${base}/api/workspace`, {
        headers: { cookie },
      });
      const workspace = await workspaceResponse.json() as any;
      const linkedSkill = workspace.skills.find((skill: any) => skill.name === "nova-owned");
      const ledger = JSON.parse(await readFile(join(equipHome, "ledger.json"), "utf8"));
      assert.deepEqual(
        Object.values(ledger.installs).map((entry: any) => entry.revision).sort(),
        [linkedSkill.revision, linkedSkill.revision].sort(),
      );

      const publish = await fetch(`${base}/api/skills/${linkedSkill.id}/publish`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ files: linkedSkill.files }),
      });
      assert.equal(publish.status, 409);

      const link = JSON.parse(await readFile(join(equipHome, "library-link.json"), "utf8"));
      const unlink = await fetch(`${base}/api/library/unlink`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: "{}",
      });
      assert.equal(unlink.status, 200);
      await writeFile(join(skillRoot, "SKILL.md"), third);
      await runCli(["sync"], environment);
      await assert.rejects(readFile(join(equipHome, "library-link.json"), "utf8"), /ENOENT/);
      assert.equal(await readFile(join(targetOne, "nova-owned", "SKILL.md"), "utf8"), second);
      assert.equal(await readFile(join(targetTwo, "nova-owned", "SKILL.md"), "utf8"), second);

      const nextSnapshot = await readNovaLibrary(nova);
      const stalePublish = await fetch(`${base}/api/device/library`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${state.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          id: "nova",
          name: "Nova",
          expectedRevision: link.revision,
          ...nextSnapshot,
        }),
      });
      assert.equal(stalePublish.status, 409);
      const finalWorkspace = await fetch(`${base}/api/workspace`, {
        headers: { cookie },
      }).then((response) => response.json()) as any;
      assert.equal(finalWorkspace.librarySource, undefined);
      assert.equal(
        finalWorkspace.skills.find((skill: any) => skill.name === "nova-owned").files.find((file: any) => file.path === "SKILL.md").content,
        second,
      );
    } finally {
      await new Promise<void>((done) => listener.close(() => done()));
      await close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
