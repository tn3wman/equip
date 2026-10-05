import assert from "node:assert/strict";
import { test } from "node:test";
import YAML from "yaml";
import { buildSkillDraft } from "../server/skill-draft.ts";

function metadata(content: string) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match);
  return YAML.parse(match[1]) as { name: string; description: string };
}

test("workflow builder rejects missing, oversized, and unsafe input", () => {
  assert.throws(
    () => buildSkillDraft({ title: "Release notes", workflow: "  " }),
    /Describe the workflow/,
  );
  assert.throws(
    () => buildSkillDraft({ title: "---", workflow: "Review the changes." }),
    /form a skill name/,
  );
  assert.throws(
    () => buildSkillDraft({ title: "Bad\nheading", workflow: "Review." }),
    /one line/,
  );
  assert.throws(
    () =>
      buildSkillDraft({
        title: "Long workflow",
        workflow: "x".repeat(12_001),
      }),
    /at most 12000/,
  );
});

test("workflow builder creates a valid grounded Agent Skill", () => {
  const workflow =
    "Read the pull request and list changed behavior.\nKeep security findings separate.\n\nCompare each finding with the source before reporting it.";
  const [file] = buildSkillDraft({ title: "Review PR changes", workflow });
  assert.equal(file.path, "SKILL.md");
  assert.equal(file.mode, undefined);
  const frontmatter = metadata(file.content);
  assert.equal(frontmatter.name, "review-pr-changes");
  assert.match(frontmatter.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.ok(frontmatter.description.length <= 1024);
  assert.match(frontmatter.description, /Read the pull request/);
  assert.match(file.content, /## When to use/);
  assert.match(file.content, /## Inputs/);
  assert.match(file.content, /## Workflow/);
  assert.match(file.content, /## Verification/);
  assert.match(file.content, /1\. Read the pull request and list changed behavior\./);
  assert.match(file.content, /Keep security findings separate\./);
  assert.match(
    file.content,
    /2\. Compare each finding with the source before reporting it\./,
  );
  assert.doesNotMatch(file.content, /shell|browser|API|guarantee/i);
});
