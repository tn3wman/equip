import assert from "node:assert/strict";
import test from "node:test";
import { unzipSync } from "fflate";
import { skillArchive } from "../shared/archive.ts";

function unixModes(archive: Uint8Array) {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const modes = new Map<string, number>();
  for (let offset = 0; offset <= archive.byteLength - 46; offset += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue;
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const name = Buffer.from(archive.subarray(offset + 46, offset + 46 + nameLength)).toString();
    modes.set(name, view.getUint32(offset + 38, true) >>> 16);
    offset += 45 + nameLength + extraLength + commentLength;
  }
  return modes;
}

test("skill archive preserves every file, binary bytes, Unix modes, and deterministic output", async () => {
  const files = [
    {
      path: "SKILL.md",
      content: "---\nname: exact-export\ndescription: Complete fixture\n---\n\n# Exact export\n",
      mode: 0o644,
    },
    {
      path: "scripts/run.sh",
      content: "#!/bin/sh\nprintf 'ready\\n'\n",
      mode: 0o755,
    },
    {
      path: "assets/payload.bin",
      content: Buffer.from([0, 1, 2, 127, 128, 254, 255]).toString("base64"),
      encoding: "base64" as const,
      mode: 0o600,
    },
  ];

  const first = await skillArchive("exact-export", files);
  const second = await skillArchive("exact-export", [...files].reverse());
  const extracted = unzipSync(first);
  const modes = unixModes(first);

  assert.deepEqual(first, second);
  assert.deepEqual(Object.keys(extracted).sort(), [
    "exact-export/SKILL.md",
    "exact-export/assets/payload.bin",
    "exact-export/scripts/run.sh",
  ]);
  assert.equal(Buffer.from(extracted["exact-export/SKILL.md"]!).toString(), files[0]!.content);
  assert.equal(Buffer.from(extracted["exact-export/scripts/run.sh"]!).toString(), files[1]!.content);
  assert.deepEqual(extracted["exact-export/assets/payload.bin"], new Uint8Array([0, 1, 2, 127, 128, 254, 255]));
  assert.equal(modes.get("exact-export/SKILL.md")! & 0o777, 0o644);
  assert.equal(modes.get("exact-export/scripts/run.sh")! & 0o777, 0o755);
  assert.equal(modes.get("exact-export/assets/payload.bin")! & 0o777, 0o600);
});

test("skill archive rejects unsafe names and paths", () => {
  const content = "---\nname: safe\ndescription: Safe\n---\n";
  for (const name of ["", "UPPER", "../escape", "has spaces"]) {
    assert.throws(() => skillArchive(name, [{ path: "SKILL.md", content }]), /Invalid archive skill name/);
  }
  for (const path of ["", "/absolute", "../escape", "nested/../escape", "nested//file", "win\\file"]) {
    assert.throws(() => skillArchive("safe", [{ path, content }]), /Unsafe archive path/);
  }
});
