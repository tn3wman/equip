import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { replaceExecutable } from "../cli/update.ts";

test("macOS update atomically replaces the executable without a previous-file gap", async () => {
  const root = await mkdtemp(join(tmpdir(), "equip-update-"));
  const executable = join(root, "equip.cjs");
  await writeFile(executable, "old", { mode: 0o755 });
  await replaceExecutable(executable, Buffer.from("new"), "darwin");
  assert.equal(await readFile(executable, "utf8"), "new");
  assert.equal((await stat(executable)).mode & 0o777, 0o755);
  assert.deepEqual(await readdir(root), ["equip.cjs"]);
});
