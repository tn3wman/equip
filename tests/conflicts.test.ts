import assert from "node:assert/strict";
import test from "node:test";
import { compareSkillFiles, diffLines, reviewedFilesRevision } from "../shared/conflicts.ts";
import { skillRevision } from "../shared/library.ts";

test("review fingerprints match the server for UTF-8, binary, order and modes", async () => {
  const files = [
    { path: "script.sh", content: "#!/bin/sh\n", mode: 0o755 },
    { path: "SKILL.md", content: "héllo 🌍\n" },
    { path: "asset.bin", content: "/wB/", encoding: "base64" as const },
  ];
  assert.equal(await reviewedFilesRevision(files), skillRevision(files));
  assert.equal(await reviewedFilesRevision([...files].reverse()), skillRevision(files));
});

test("conflict review compares complete bytes, permissions, additions and removals", () => {
  const files = compareSkillFiles([
    { path: "same.txt", content: "identical" },
    { path: "SKILL.md", content: "local" },
    { path: "run.sh", content: "#!/bin/sh", mode: 0o755 },
    { path: "local.txt", content: "retain me" },
    { path: "binary.bin", content: "/wA=", encoding: "base64" },
  ], [
    { path: "same.txt", content: Buffer.from("identical").toString("base64"), encoding: "base64", mode: 0o644 },
    { path: "SKILL.md", content: "equip" },
    { path: "run.sh", content: "#!/bin/sh", mode: 0o644 },
    { path: "new.txt", content: "new" },
    { path: "binary.bin", content: "/wE=", encoding: "base64" },
  ]);
  assert.deepEqual(files.map(file => [file.path, file.status]), [
    ["SKILL.md", "modified"], ["binary.bin", "modified"], ["local.txt", "removed"], ["new.txt", "added"], ["run.sh", "permissions"],
  ]);
  assert.equal(files[1].binary, true);
  assert.equal(files[1].localText, undefined);
  assert.equal(files[4].contentChanged, false);
  assert.equal(files[4].modeChanged, true);
});

test("line comparison aligns insertions and retains both complete versions", () => {
  const local = "start\nlocal\nshared\nend\n";
  const equip = "start\nequip\ninserted\nshared\nend\n";
  const diff = diffLines(local, equip);
  assert.equal(diff.filter(line => line.kind !== "add").map(line => line.text).join("\n"), local);
  assert.equal(diff.filter(line => line.kind !== "remove").map(line => line.text).join("\n"), equip);
  assert.deepEqual(diff.filter(line => line.kind !== "same").map(line => [line.kind, line.text]), [["remove", "local"], ["add", "equip"], ["add", "inserted"]]);
  assert.equal(diff.find(line => line.text === "shared")?.equipLine, 4);
});

test("large generated files use a bounded comparison while preserving all content", () => {
  const local = Array.from({ length: 1000 }, (_, i) => `local ${i}`).join("\n");
  const equip = Array.from({ length: 1000 }, (_, i) => `equip ${i}`).join("\n");
  const diff = diffLines(local, equip);
  assert.equal(diff.length, 2000);
  assert.equal(diff.filter(line => line.kind === "remove").map(line => line.text).join("\n"), local);
  assert.equal(diff.filter(line => line.kind === "add").map(line => line.text).join("\n"), equip);
});
