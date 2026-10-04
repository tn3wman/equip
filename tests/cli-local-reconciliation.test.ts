import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { syncLocalSkills, type LocalPublication } from "../cli/local.ts";
import type { DesiredState, Skill, SkillFile } from "../shared/types.ts";

function skill(name: string, content: string, revision: string): Skill {
  return {
    id: `skill-${name}`,
    name,
    title: name,
    description: "Fixture",
    author: "test",
    source: "test",
    kind: "custom",
    category: "Test",
    icon: "",
    color: "",
    selected: true,
    enabled: true,
    autoUpdate: true,
    revision,
    versions: [],
    files: [{ path: "SKILL.md", content }],
    requirements: [],
    targets: [],
    updatedAt: new Date(0).toISOString(),
  };
}

function desired(skills: Skill[]): DesiredState {
  return { generation: 1, skills, resolutions: {}, localSync: true };
}

function fileHashes(files: SkillFile[]) {
  return Object.fromEntries(files.map((file) => [
    file.path,
    `${file.mode ?? 0o644}:${createHash("sha256")
      .update(Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8"))
      .digest("hex")}`,
  ]));
}

function contents(name: string, body: string) {
  return `---\nname: ${name}\ndescription: Fixture\n---\n\n${body}\n`;
}

async function localFolder(root: string, directory: string, name: string, body: string) {
  const path = join(root, directory);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), contents(name, body));
  return path;
}

test("an unrelated profile ledger entry is not borrowed as the base for an unknown local copy", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "equip-local-reconcile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "equip");
  const target = join(root, "new-computer");
  const localPath = await localFolder(target, "demo", "demo", "# New computer edit");
  const remote = skill("demo", contents("demo", "# Published"), "remote-r2");
  const otherPath = join(root, "other-computer", "demo");
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "ledger.json"), JSON.stringify({
    installs: {
      "skill-demo:codex:work:": {
        skillId: remote.id,
        path: otherPath,
        revision: "other-profile-r1",
        files: fileHashes(remote.files),
      },
    },
  }));
  const publications: LocalPublication[] = [];

  await syncLocalSkills(home, [{ id: "codex", path: target, profile: "personal" }], desired([remote]), async (publication) => {
    publications.push(publication);
    return { id: remote.id, revision: "published-r3", changed: true };
  });

  assert.equal(publications.length, 1);
  assert.equal(publications[0].sourcePath, await realpath(localPath));
  assert.equal(publications[0].baseRevision, undefined);
});

test("a local edit uses the installed copy's latest ledger revision after a dashboard update", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "equip-local-reconcile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "equip");
  const target = join(root, "codex");
  const localPath = await localFolder(target, "demo", "demo", "# Device edit");
  const dashboardFiles = [{ path: "SKILL.md", content: contents("demo", "# Dashboard update") }];
  const remote = { ...skill("demo", dashboardFiles[0].content, "dashboard-r2"), files: dashboardFiles };
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "local-skills.json"), JSON.stringify({
    [localPath]: { name: "demo", hash: "stale-local-hash", revision: "seen-r1" },
  }));
  await writeFile(join(home, "ledger.json"), JSON.stringify({
    installs: {
      "skill-demo:codex:default:": {
        skillId: remote.id,
        path: localPath,
        canonicalPath: localPath,
        revision: "dashboard-r2",
        files: fileHashes(dashboardFiles),
      },
    },
  }));
  const publications: LocalPublication[] = [];

  await syncLocalSkills(home, [{ id: "codex", path: target, profile: "default" }], desired([remote]), async (publication) => {
    publications.push(publication);
    return { id: remote.id, revision: "device-r3", changed: true };
  });

  assert.equal(publications.length, 1);
  assert.equal(publications[0].baseRevision, "dashboard-r2");
  assert.match(publications[0].files[0].content, /# Device edit/);
});

test("different preexisting folders with the same new skill name wait for review before publishing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "equip-local-reconcile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "equip");
  const firstRoot = join(root, "codex");
  const secondRoot = join(root, "claude");
  const first = await localFolder(firstRoot, "first-folder", "shared-name", "# First copy");
  const second = await localFolder(secondRoot, "second-folder", "shared-name", "# Second copy");
  const publications: LocalPublication[] = [];

  const result = await syncLocalSkills(
    home,
    [{ id: "codex", path: firstRoot }, { id: "claude-code", path: secondRoot }],
    desired([]),
    async (publication) => {
      publications.push(publication);
      return { id: "skill-shared-name", revision: "published-r1", changed: true };
    },
  );

  assert.deepEqual(publications, []);
  assert.deepEqual(result.errors, ["shared-name: different local copies need review."]);
  assert.equal(await readFile(join(first, "SKILL.md"), "utf8"), contents("shared-name", "# First copy"));
  assert.equal(await readFile(join(second, "SKILL.md"), "utf8"), contents("shared-name", "# Second copy"));
});
