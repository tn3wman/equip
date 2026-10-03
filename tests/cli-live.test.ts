import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import test from "node:test";
import { createApp } from "../server/app.ts";

test(
  "CLI completes device authorization and first sync against an isolated live server",
  { timeout: 15_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "equip-cli-live-"));
    const { app, close } = await createApp({
      dataDir: join(root, "server"),
      autoUpdateIntervalMs: 0,
    });
    const listener = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => listener.once("listening", resolve));
    const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
    try {
      const registration = await fetch(`${base}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "CLI Test",
          email: `cli-${Date.now()}@example.com`,
          password: "test-password-123",
        }),
      });
      const cookie = registration.headers.get("set-cookie")?.split(";")[0];
      assert.equal(registration.status, 201);
      const source = join(root, "private-source");
      await import("node:fs/promises").then(async (fs) => {
        await fs.mkdir(source);
        await fs.writeFile(
          join(source, "SKILL.md"),
          "---\nname: private-test\ndescription: Device-resolved source\n---\n# Private\n",
        );
      });
      const queued = await fetch(`${base}/api/skills/install`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: cookie! },
        body: JSON.stringify({ source }),
      });
      assert.equal(queued.status, 202);
      const bundle = resolve("dist/equip.cjs");
      const bundled = existsSync(bundle);
      const child = spawn(
        process.execPath,
        bundled
          ? [bundle, "connect", "--headless", "--once", "--server", base]
          : [
              "--import",
              "tsx",
              "cli/index.ts",
              "connect",
              "--headless",
              "--once",
              "--server",
              base,
            ],
        {
          cwd: bundled ? tmpdir() : process.cwd(),
          env: {
            ...process.env,
            EQUIP_HOME: join(root, "client"),
            EQUIP_AGENT_HOME: join(root, "fake-agent-home"),
            EQUIP_TARGET: join(root, "target"),
            EQUIP_AGENT: "codex",
            EQUIP_SKILLS_ROOT: resolve("node_modules/skills"),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      let approved = false;
      child.stdout.on("data", async (chunk) => {
        output += chunk.toString();
        const code = output.match(/Code: ([A-Z0-9-]+)/)?.[1];
        if (code && !approved) {
          approved = true;
          await fetch(`${base}/api/device/approve`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie: cookie! },
            body: JSON.stringify({ userCode: code }),
          });
        }
      });
      child.stderr.on("data", (chunk) => {
        output += chunk.toString();
      });
      const exit = await new Promise<number | null>((resolve, reject) => {
        child.once("exit", resolve);
        child.once("error", reject);
      });
      assert.equal(exit, 0, output);
      assert.match(output, /Connected and synchronized 1 installation/);
      const state = JSON.parse(
        await readFile(join(root, "client/state.json"), "utf8"),
      );
      assert.ok(state.token);
      assert.equal(state.server, base);
      assert.equal(state.autoDetect, false);
      assert.equal(
        await readFile(join(root, "target/private-test/SKILL.md"), "utf8"),
        "---\nname: private-test\ndescription: Device-resolved source\n---\n# Private\n",
      );
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
      await close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
