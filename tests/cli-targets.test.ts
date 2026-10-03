import assert from "node:assert/strict";
import test from "node:test";
import { selectAgentTargets } from "../cli/targets.ts";

const agents = [
  {
    id: "codex",
    globalPath: "/home/.codex/skills",
    projectPath: ".agents/skills",
  },
  { id: "eve", globalPath: "", projectPath: "agent/skills" },
];

test("default target selection skips detected project-only agents", () => {
  assert.deepEqual(selectAgentTargets(agents, agents), [
    { id: "codex", path: "/home/.codex/skills", profile: undefined },
  ]);
});

test("explicit project-only agent requires and respects a project root", () => {
  assert.throws(
    () => selectAgentTargets(agents, agents, ["eve"]),
    /provide --project/,
  );
  const selected = selectAgentTargets(agents, agents, ["eve"], "/workspace");
  assert.equal(selected[0].path, "/workspace/agent/skills");
  assert.equal(selected[0].project, "/workspace");
});
