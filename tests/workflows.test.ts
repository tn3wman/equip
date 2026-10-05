import assert from "node:assert/strict";
import test from "node:test";
import type { Skill } from "../shared/types.ts";
import { findWorkflowOverlap, skillSourceKey, workflowCollections } from "../shared/workflows.ts";

const skill = (fields: Partial<Skill>): Skill => ({
  id: "skill", name: "skill", title: "Skill", description: "", author: "test",
  source: "https://github.com/example/repo", kind: "third-party", category: "Community",
  icon: "Sparkles", color: "#000", selected: false, enabled: false, autoUpdate: false,
  revision: "", versions: [], files: [], requirements: [], targets: [], updatedAt: new Date(0).toISOString(),
  ...fields,
});

test("workflow collections are search queries rather than invented catalog entries", () => {
  assert.ok(workflowCollections.length >= 5);
  assert.ok(workflowCollections.every(item => item.query.length >= 2 && item.purpose.length > item.label.length));
  assert.equal(new Set(workflowCollections.map(item => item.id)).size, workflowCollections.length);
});

test("source keys normalize common GitHub source forms", () => {
  assert.equal(skillSourceKey(skill({ source: "git+https://github.com/Example/Repo.git", name: "Review" })), "example/repo:review");
  assert.equal(skillSourceKey(skill({ source: "git@github.com:Example/Repo.git", name: "Review" })), "example/repo:review");
});

test("overlap hints require strong shared workflow language", () => {
  const selected = skill({ name: "browser-accessibility-audit", title: "Browser accessibility audit", description: "Inspect pages for keyboard and screen reader problems." });
  assert.equal(findWorkflowOverlap(skill({ name: "accessibility-browser-review", title: "Accessibility browser review" }), [selected]), selected);
  assert.equal(findWorkflowOverlap(skill({ name: "browser-automation", title: "Browser automation", description: "Click pages and fill forms." }), [selected]), undefined);
});

test("the same source and skill is handled as installed, not as workflow overlap", () => {
  const selected = skill({ selected: true });
  assert.equal(findWorkflowOverlap(skill({}), [selected]), undefined);
});
