import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile, rename } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { replaceExecutable, runNpmCommand } from "../cli/update.ts";
import { powershellInstaller, shellInstaller } from "../server/installers.ts";

const exec = promisify(execFile);

test("native executable replacement leaves no staging files", async () => {
  const root = await mkdtemp(join(tmpdir(), "equip-native-update-"));
  const executable = join(root, process.platform === "win32" ? "equip.cjs" : "equip");
  try {
    await writeFile(executable, "old", { mode: 0o755 });
    await replaceExecutable(executable, Buffer.from("new"));
    assert.equal(await readFile(executable, "utf8"), "new");
    if (process.platform !== "win32")
      assert.equal((await stat(executable)).mode & 0o777, 0o755);
    assert.deepEqual(await readdir(root), [process.platform === "win32" ? "equip.cjs" : "equip"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows replacement restores the previous executable when promotion fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "equip-windows-rollback-"));
  const executable = join(root, "equip.cjs");
  try {
    await writeFile(executable, "known-good", { mode: 0o755 });
    let blocked = false;
    const failPromotion: typeof rename = async (source, destination) => {
      if (!blocked && String(source).endsWith(".update") && destination === executable) {
        blocked = true;
        throw Object.assign(new Error("simulated interrupted promotion"), { code: "EACCES" });
      }
      await rename(source, destination);
    };
    await assert.rejects(
      replaceExecutable(executable, Buffer.from("incomplete"), "win32", failPromotion),
      /interrupted promotion/,
    );
    assert.equal(blocked, true);
    assert.equal(await readFile(executable, "utf8"), "known-good");
    assert.deepEqual(await readdir(root), ["equip.cjs"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows updater executes npm.cmd through the native command interpreter", async t => {
  if (process.platform !== "win32") return t.skip("Windows command shim test.");
  const root = await mkdtemp(join(tmpdir(), "equip-npm-cmd-"));
  try {
    const script = join(root, "capture args.cjs");
    const shim = join(root, "npm.cmd");
    await writeFile(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)))\n");
    await writeFile(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    const result = await runNpmCommand(shim, ["pack", "skills@1.7.0", "--json"]);
    assert.deepEqual(JSON.parse(result.stdout), ["pack", "skills@1.7.0", "--json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native first installer recovers from an interrupted package install", { timeout: 60_000 }, async t => {
  if (process.platform !== "win32" && process.platform !== "darwin" && process.platform !== "linux")
    return t.skip(`No installer for ${process.platform}.`);
  const root = await mkdtemp(join(tmpdir(), "equip-native-install-"));
  const installRoot = join(root, "install root");
  const tools = join(root, "tools");
  const log = join(root, "boot.log");
  const artifact = Buffer.from(
    "require('node:fs').appendFileSync(process.env.EQUIP_BOOT_LOG, JSON.stringify({args:process.argv.slice(2),server:process.env.EQUIP_SERVER})+'\\n');\n",
  );
  const integrity = `sha512-${Buffer.alloc(64, 9).toString("base64")}`;
  const server = createServer((request, response) => {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    if (request.url === "/cli/manifest") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        schema: 1,
        version: "1.0.0",
        node: ">=22.20.0",
        skillsVersion: "1.7.0",
        skillsIntegrity: integrity,
        sha256: createHash("sha256").update(artifact).digest("hex"),
        url: `${origin}/cli/equip.cjs`,
        origin,
        signature: "bootstrap-does-not-trust-this-field",
      }));
      return;
    }
    if (request.url === "/cli/equip.cjs") {
      response.setHeader("content-type", "application/octet-stream");
      response.end(artifact);
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await mkdir(tools, { recursive: true });
    const fakeNpm = join(tools, "fake-npm.cjs");
    await writeFile(fakeNpm, `
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2);
if(args[0]==='view'){process.stdout.write(${JSON.stringify(JSON.stringify(integrity))});process.exit(0)}
if(args[0]==='install'){
  if(process.env.EQUIP_TEST_INTERRUPT==='1')process.exit(23);
  const prefix=args[args.indexOf('--prefix')+1],version=args.at(-1).split('@').at(-1);
  const folder=path.join(prefix,'node_modules','skills');fs.mkdirSync(folder,{recursive:true});
  fs.writeFileSync(path.join(folder,'package.json'),JSON.stringify({name:'skills',version}));process.exit(0);
}
process.exit(2);
`);
    if (process.platform === "win32") {
      await writeFile(join(tools, "npm.cmd"), `@echo off\r\n"${process.execPath}" "${fakeNpm}" %*\r\n`);
    } else {
      const npm = join(tools, "npm");
      await writeFile(npm, `#!${process.execPath}\nrequire(${JSON.stringify(fakeNpm)});\n`, { mode: 0o755 });
      await chmod(npm, 0o755);
    }
    const script = join(root, process.platform === "win32" ? "install.ps1" : "install.sh");
    await writeFile(script, process.platform === "win32" ? powershellInstaller(origin, "unused") : shellInstaller(origin, "unused"));
    const command = process.platform === "win32" ? "powershell.exe" : "sh";
    const commandArgs = process.platform === "win32"
      ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script]
      : [script];
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${tools}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
      EQUIP_INSTALL_ROOT: installRoot,
      EQUIP_NO_PROFILE: "1",
      EQUIP_HEADLESS: "1",
      EQUIP_NO_SERVICE: "1",
      EQUIP_BOOT_LOG: log,
      EQUIP_TEST_INTERRUPT: "1",
    };
    await assert.rejects(exec(command, commandArgs, { env: environment }), /Command failed/);
    assert.equal(await readFile(join(installRoot, "runtime", "equip.cjs"), "utf8"), artifact.toString());
    const launcher = join(installRoot, "bin", process.platform === "win32" ? "equip.cmd" : "equip");
    await assert.rejects(readFile(launcher), { code: "ENOENT" });

    delete environment.EQUIP_TEST_INTERRUPT;
    await exec(command, commandArgs, { env: environment });
    const launches = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(launches.at(-1), { args: ["connect", "--headless", "--no-service"], server: origin });
    assert.ok((await stat(launcher)).isFile());
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
