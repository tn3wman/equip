import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { checkCliRelease } from "../scripts/check-cli-release.ts";

const exec = promisify(execFile);

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "equip-cli-version-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "cli"));
  await mkdir(join(root, "shared"));
  await mkdir(join(root, "web"));
  await writeFile(join(root, "cli/index.ts"), 'import { value } from "./value.ts"; import type { Label } from "./types.ts"; console.log(value as Label);\n');
  await writeFile(join(root, "cli/value.ts"), 'export const value = "base";\n');
  await writeFile(join(root, "cli/types.ts"), 'export type Label = string;\n');
  await writeFile(join(root, "shared/release.ts"), 'export const CLI_RELEASE_VERSION = "1.1.2";\n');
  await writeFile(join(root, "web/app.ts"), 'export const page = "base";\n');
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ scripts: { "build:cli": "esbuild cli/index.ts --bundle --platform=node --format=cjs --target=node22.20 --external:skills --outfile=dist/equip.cjs" } }),
  );
  await writeFile(join(root, "package-lock.json"), "{}\n");
  await exec("git", ["init", "-q"], { cwd: root });
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "base"], { cwd: root });
  return root;
}

async function setVersion(root: string, version: string) {
  await writeFile(join(root, "shared/release.ts"), `export const CLI_RELEASE_VERSION = "${version}";\n`);
}

test("rejects a bundled CLI change without a version bump", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "cli/value.ts"), 'export const value = "changed";\n');
  await assert.rejects(() => checkCliRelease("HEAD", root), /must be newer than 1\.1\.2; found 1\.1\.2/);
});

test("accepts a bundled CLI change with a newer version", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "cli/value.ts"), 'export const value = "changed";\n');
  await setVersion(root, "1.1.3");
  assert.match(await checkCliRelease("HEAD", root), /advanced from 1\.1\.2 to 1\.1\.3/);
});

test("rejects a bundled CLI change with an older version", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "cli/value.ts"), 'export const value = "changed";\n');
  await setVersion(root, "1.1.1");
  await assert.rejects(() => checkCliRelease("HEAD", root), /must be newer than 1\.1\.2; found 1\.1\.1/);
});

test("allows frontend-only changes without a version bump", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "web/app.ts"), 'export const page = "changed";\n');
  assert.match(await checkCliRelease("HEAD", root), /bundle is unaffected/);
});

test("detects a newly imported untracked CLI dependency", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "cli/index.ts"), 'import { added } from "./added.ts"; console.log(added);\n');
  await writeFile(join(root, "cli/added.ts"), 'export const added = "new";\n');
  await assert.rejects(() => checkCliRelease("HEAD", root), /cli\/added\.ts/);
});

test("detects removal of a previously bundled CLI dependency", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "cli/index.ts"), 'console.log("no dependency");\n');
  await rm(join(root, "cli/value.ts"));
  await assert.rejects(() => checkCliRelease("HEAD", root), /cli\/value\.ts/);
});

test("ignores changes to type-only CLI dependencies", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "cli/types.ts"), 'export type Label = string & { readonly label: unique symbol };\n');
  assert.match(await checkCliRelease("HEAD", root), /bundle is unaffected/);
});

for (const [name, change, expected] of [
  ["package lock", (root: string) => writeFile(join(root, "package-lock.json"), '{"changed":true}\n'), /package-lock\.json/],
  ["CLI build command", (root: string) => writeFile(
    join(root, "package.json"),
    JSON.stringify({ scripts: { "build:cli": "esbuild cli/index.ts --bundle --format=esm --outfile=dist/equip.mjs" } }),
  ), /package\.json build:cli/],
] as const) {
  test(`detects a changed ${name}`, async (t) => {
    const root = await fixture(t);
    await change(root);
    await assert.rejects(() => checkCliRelease("HEAD", root), expected);
  });
}
