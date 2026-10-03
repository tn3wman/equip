import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { powershellInstaller, shellInstaller } from "../server/installers.ts";

const exec = promisify(execFile);

test("shell installer is valid and keeps isolated runs out of PATH and profile files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "equip-installer-test-"));
  const script = path.join(root, "install.sh");
  try {
    const content = shellInstaller("http://127.0.0.1:4310", "1.7.0");
    await writeFile(script, content);
    await exec("sh", ["-n", script]);
    assert.match(content, /EQUIP_NO_PROFILE/);
    assert.match(content, /cli\/manifest/);
    assert.match(content, /CLI checksum mismatch/);
    assert.match(content, /export EQUIP_NPM_CLI/);
    assert.match(content, /write-launcher\.cjs/);
    assert.doesNotMatch(content, /ln -sf/);
    assert.doesNotMatch(content, /cp "\$node_bin"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PowerShell installer verifies Node and CLI archives and bakes runtime paths", () => {
  const content = powershellInstaller("http://127.0.0.1:4310", "1.7.0");
  assert.match(content, /Get-FileHash/);
  assert.match(content, /manifest\.json/);
  assert.match(content, /EQUIP_NPM_CLI/);
  assert.match(content, /SetEnvironmentVariable\('Path'/);
  assert.match(content, /EQUIP_NO_PROFILE/);
  assert.match(content, /-Encoding Ascii/);
  assert.match(content, /npm failed with exit code/);
  assert.doesNotMatch(content, /Copy-Item \$nodePath/);
});

test("generated Unix launcher executes from a quoted custom install path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "equip-launcher-test-"));
  try {
    const installRoot = path.join(root, "equip quoted'boot");
    const runtime = path.join(installRoot, "runtime"); const bin = path.join(installRoot, "bin");
    await mkdir(runtime, { recursive: true }); await mkdir(bin, { recursive: true });
    const installer = shellInstaller("http://127.0.0.1:4310", "1.7.0");
    const helper = installer.match(/<<'EQUIP_LAUNCHER'\n([\s\S]*?)\nEQUIP_LAUNCHER/)?.[1];
    assert.ok(helper);
    const helperPath = path.join(runtime, "write-launcher.cjs"); const launcher = path.join(bin, "equip");
    await writeFile(helperPath, helper);
    await writeFile(path.join(runtime, "equip.cjs"), "console.log(JSON.stringify({args:process.argv.slice(2),home:process.env.EQUIP_HOME}))\n");
    await exec(process.execPath, [helperPath, launcher, "http://127.0.0.1:4310", installRoot, runtime, path.join(runtime, "npm cli.js"), process.execPath]);
    await exec("sh", ["-n", launcher]);
    const result = await exec(launcher, ["one two", "three"]);
    assert.deepEqual(JSON.parse(result.stdout), { args: ["one two", "three"], home: `${installRoot}/state` });
    assert.ok((await readFile(launcher, "utf8")).includes("quoted'\\''boot"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
