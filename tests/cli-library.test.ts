import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
  readLibraryLink,
  readLibrarySnapshot,
  saveLibraryLink,
  syncLinkedLibrary,
} from "../cli/library.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "equip-library-"));
  await mkdir(join(root, "skills"));
  await writeFile(join(root, "skills/skills-sh.json"), "{}\n");
  return root;
}

async function customSkill(root: string, name: string, description = "Fixture") {
  const directory = join(root, "skills", name);
  await mkdir(directory);
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`,
  );
  return directory;
}

test("Nova snapshot combines owned and installed skills and preserves bytes and modes", async () => {
  const root = await fixture();
  const installed = join(root, "installed");
  const owned = await customSkill(root, "owned-skill");
  await mkdir(join(installed, "third-party"), { recursive: true });
  await writeFile(
    join(installed, "third-party/SKILL.md"),
    "---\nname: third-party\ndescription: Installed\n---\n",
  );
  await writeFile(
    join(root, "skills/skills-sh.json"),
    JSON.stringify({ "third-party": "owner/repository" }),
  );
  await writeFile(join(owned, "binary.dat"), Buffer.from([0xff, 0x00, 0xfe]));
  await writeFile(join(owned, "run.sh"), "#!/bin/sh\nexit 0\n");
  await chmod(join(owned, "run.sh"), 0o755);

  const snapshot = await readLibrarySnapshot(root, { installedSkills: installed });
  assert.deepEqual(
    snapshot.skills.map(({ name, source, kind }) => ({ name, source, kind })),
    [
      {
        name: "owned-skill",
        source: `${basename(root).toLowerCase()}:skills/owned-skill`,
        kind: "custom",
      },
      {
        name: "third-party",
        source: "owner/repository",
        kind: "third-party",
      },
    ],
  );
  const files = snapshot.skills[0].files;
  const binary = files.find((file) => file.path === "binary.dat");
  assert.equal(binary?.encoding, "base64");
  assert.deepEqual(Buffer.from(binary!.content, "base64"), Buffer.from([0xff, 0x00, 0xfe]));
  assert.equal(files.find((file) => file.path === "run.sh")?.mode, 0o755);
  assert.match(snapshot.revision, /^[a-f0-9]{64}$/);
});

test("a missing listed skill is resolved through the supplied resolver", async () => {
  const root = await fixture();
  const installed = join(root, "installed");
  await writeFile(
    join(root, "skills/skills-sh.json"),
    JSON.stringify({ missing: "owner/repository" }),
  );
  const calls: unknown[][] = [];
  const snapshot = await readLibrarySnapshot(root, {
    installedSkills: installed,
    resolveMissing: async (...args) => {
      calls.push(args);
      return {
        name: "missing",
        title: "Missing",
        description: "Resolved",
        author: "Fixture",
        source: "owner/repository",
        category: "Test",
        icon: "Sparkles",
        color: "#000000",
        revision: "resolved",
        requirements: [],
        files: [
          {
            path: "SKILL.md",
            content: "---\nname: missing\ndescription: Resolved\n---\n",
          },
        ],
      };
    },
  });
  assert.deepEqual(calls, [["owner/repository", "missing"]]);
  assert.equal(snapshot.skills[0].name, "missing");
});

test("malformed or mismatched Nova skill metadata is rejected", async () => {
  const root = await fixture();
  const directory = await customSkill(root, "broken-skill");
  await writeFile(join(directory, "SKILL.md"), "---\nname: another-name\n---\n");
  await assert.rejects(
    readLibrarySnapshot(root, { installedSkills: join(root, "installed") }),
    /invalid or mismatched SKILL\.md metadata/,
  );
});

test("a manifest mutation during missing-skill resolution rejects the snapshot", async () => {
  const root = await fixture();
  const manifest = join(root, "skills/skills-sh.json");
  await writeFile(manifest, JSON.stringify({ missing: "owner/repository" }));
  await assert.rejects(
    readLibrarySnapshot(root, {
      installedSkills: join(root, "installed"),
      resolveMissing: async () => {
        await writeFile(manifest, JSON.stringify({ missing: "owner/changed" }));
        return {
          name: "missing",
          title: "Missing",
          description: "Resolved",
          author: "Fixture",
          source: "owner/repository",
          category: "Test",
          icon: "Sparkles",
          color: "#000000",
          revision: "resolved",
          requirements: [],
          files: [
            {
              path: "SKILL.md",
              content: "---\nname: missing\ndescription: Resolved\n---\n",
            },
          ],
        };
      },
    }),
    /The library changed while its skills were being read/,
  );
});

test("linked library sync is idempotent and a failed publish retains the accepted revision", async () => {
  const root = await fixture();
  const home = join(root, "equip-home");
  const directory = await customSkill(root, "owned-skill", "First");
  await saveLibraryLink(home, { id: "nova", name: "Nova", root });
  let publishes = 0;
  const publish = async (payload: { revision: string }) => {
    publishes += 1;
    return { accepted: true, revision: payload.revision };
  };
  await syncLinkedLibrary(home, publish);
  const accepted = await readLibraryLink(home);
  assert.equal(publishes, 1);
  assert.ok(accepted?.revision);
  assert.ok(accepted?.lastSync);
  await syncLinkedLibrary(home, publish);
  assert.equal(publishes, 1);

  await writeFile(
    join(directory, "SKILL.md"),
    "---\nname: owned-skill\ndescription: Second\n---\n",
  );
  await assert.rejects(
    syncLinkedLibrary(home, async () => ({ accepted: false, revision: "rejected" })),
    /did not accept the library’s complete skill revision/,
  );
  const failed = await readLibraryLink(home);
  assert.equal(failed?.revision, accepted?.revision);
  assert.ok(failed?.lastError);
  assert.equal(await readFile(join(home, "library-link.json"), "utf8").then(JSON.parse).then((link) => link.revision), accepted?.revision);
});
