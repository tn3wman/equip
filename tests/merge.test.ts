import assert from "node:assert/strict";
import test from "node:test";
import type { SkillFile } from "../shared/types.ts";
import { hasMergeMarkers, mergeSkillFiles, mergeText } from "../shared/merge.ts";

const file = (path: string, content: string, mode = 0o644): SkillFile => ({ path, content, mode });

test("nonoverlapping and adjacent line edits combine with the final newline intact", () => {
  const base = "one\ntwo\nthree\nfour\n";
  const local = "ONE\ntwo\nthree\nfour\n";
  const equip = "one\ntwo\nTHREE\nFOUR\n";
  assert.deepEqual(mergeText(base, local, equip), { content: "ONE\ntwo\nTHREE\nFOUR\n", conflicted: false });
  assert.deepEqual(mergeText("a\nb\nc", "A\nb\nc", "a\nB\nc"), { content: "A\nB\nc", conflicted: false });
});

test("overlapping text edits produce explicit unresolved markers", () => {
  const merged = mergeText("a\nb\nc\n", "a\nlocal\nc\n", "a\nequip\nc\n");
  assert.equal(merged.conflicted, true);
  assert.equal(hasMergeMarkers(merged.content), true);
  assert.match(merged.content, /<<<<<<< LOCAL[\s\S]*\|\|\|\|\|\|\| BASE[\s\S]*>>>>>>> EQUIP/);
});

test("independent additions and deletions preserve the complete folder", () => {
  const base = [file("keep.txt", "keep\n"), file("remove.txt", "old\n")];
  const local = [file("keep.txt", "local\n"), file("local.txt", "local add\n")];
  const equip = [file("keep.txt", "keep\n"), file("equip.txt", "equip add\n")];
  const merged = mergeSkillFiles(base, local, equip);
  assert.deepEqual(merged.conflicts, []);
  assert.deepEqual(merged.files.map(item => item.path), ["equip.txt", "keep.txt", "local.txt"]);
  assert.equal(merged.files.find(item => item.path === "keep.txt")?.content, "local\n");
});

test("delete versus change and different binary additions require a side choice", () => {
  const binary = (path: string, content: string): SkillFile => ({ path, content, encoding: "base64" });
  const merged = mergeSkillFiles(
    [file("changed.txt", "base" )],
    [file("changed.txt", "local"), binary("asset.bin", "AA==")],
    [binary("asset.bin", "AQ==")],
  );
  assert.deepEqual(merged.conflicts.map(item => [item.path, item.kind]), [
    ["asset.bin", "binary"],
    ["changed.txt", "delete-change"],
  ]);
});

test("content and executable changes on different sides combine", () => {
  const merged = mergeSkillFiles(
    [file("run.sh", "echo old\n", 0o644)],
    [file("run.sh", "echo local\n", 0o644)],
    [file("run.sh", "echo old\n", 0o755)],
  );
  assert.deepEqual(merged.conflicts, []);
  assert.equal(merged.files[0].content, "echo local\n");
  assert.ok((merged.files[0].mode ?? 0) & 0o111);
});

test("different executable flags on a new file require a complete side choice", () => {
  const merged = mergeSkillFiles([], [file("run.sh", "same\n", 0o644)], [file("run.sh", "same\n", 0o755)]);
  assert.equal(merged.conflicts[0].kind, "mode");
  assert.equal(merged.files.length, 0);
});

test("missing baseline never assumes either folder is newer", () => {
  assert.deepEqual(mergeSkillFiles(undefined, [file("a", "local")], [file("a", "equip")]), {
    hasBase: false, files: [], conflicts: [],
  });
});
