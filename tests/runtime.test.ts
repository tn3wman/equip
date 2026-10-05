import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promoteCompatibilityRuntime } from "../server/runtime.ts";
import { getCompatibility } from "../shared/upstream.ts";

test("a broken upstream release cannot replace the working runtime or manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "equip-runtime-test-"));
  const previous = process.env.EQUIP_SKILLS_ROOT;
  try {
    const stage = join(root, "candidate");
    await mkdir(join(stage, "node_modules/skills/dist"), { recursive: true });
    await writeFile(
      join(stage, "node_modules/skills/package.json"),
      JSON.stringify({ version: "99.0.0" }),
    );
    await writeFile(
      join(stage, "node_modules/skills/dist/cli.mjs"),
      "export {};",
    );
    await writeFile(
      join(root, "active.json"),
      JSON.stringify({ version: "1.7.0" }),
    );
    await assert.rejects(
      promoteCompatibilityRuntime(stage, root, "99.0.0"),
      /bundle signature changed/,
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(root, "active.json"), "utf8")),
      { version: "1.7.0" },
    );
    assert.equal(process.env.EQUIP_SKILLS_ROOT, previous);
  } finally {
    await rm(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.EQUIP_SKILLS_ROOT;
    else process.env.EQUIP_SKILLS_ROOT = previous;
  }
});

test("promotion validates actual source installation and exposes identical upstream definitions", async () => {
  const root = await mkdtemp(join(tmpdir(), "equip-runtime-test-"));
  const previous = process.env.EQUIP_SKILLS_ROOT;
  try {
    const before = await getCompatibility();
    const stage = join(root, "candidate");
    await mkdir(stage);
    await symlink(resolve("node_modules"), join(stage, "node_modules"), "dir");
    await promoteCompatibilityRuntime(stage, root, before.version);
    const after = await getCompatibility();
    assert.equal(after.version, before.version);
    assert.deepEqual(after.agents, before.agents);
    assert.equal(
      process.env.EQUIP_SKILLS_ROOT,
      join(root, before.version, "node_modules/skills"),
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(root, "active.json"), "utf8")),
      { version: before.version },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.EQUIP_SKILLS_ROOT;
    else process.env.EQUIP_SKILLS_ROOT = previous;
  }
});
