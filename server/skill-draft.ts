import YAML from "yaml";
import type { SkillFile } from "../shared/types.ts";

const MAX_TITLE_LENGTH = 100;
const MAX_WORKFLOW_LENGTH = 12_000;

function invalid(message: string): never {
  throw Object.assign(new Error(message), { status: 400 });
}

function skillName(title: string) {
  const name = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  if (!name)
    invalid("Title must contain letters or numbers that can form a skill name.");
  return name;
}

function workflowSteps(workflow: string) {
  const paragraphs = workflow
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  return paragraphs
    .map((paragraph, index) => {
      const lines = paragraph.split("\n");
      return `${index + 1}. ${lines.join("\n   ")}`;
    })
    .join("\n");
}

export function buildSkillDraft(input: {
  title?: unknown;
  workflow?: unknown;
}): SkillFile[] {
  if (typeof input.title !== "string" || !input.title.trim())
    invalid("Title is required.");
  const title = input.title.trim();
  if (
    title.length > MAX_TITLE_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(title)
  )
    invalid(`Title must be at most ${MAX_TITLE_LENGTH} characters on one line.`);
  if (typeof input.workflow !== "string" || !input.workflow.trim())
    invalid("Describe the workflow before creating a skill draft.");
  const workflow = input.workflow.trim();
  if (workflow.length > MAX_WORKFLOW_LENGTH)
    invalid(`Workflow must be at most ${MAX_WORKFLOW_LENGTH} characters.`);

  const name = skillName(title);
  const summary = workflow.replace(/\s+/g, " ").slice(0, 880).trim();
  const description = `Use when a request matches this workflow: ${summary}`;
  const metadata = YAML.stringify({ name, description }).trim();
  const content = `---
${metadata}
---

# ${title}

## When to use

Use this skill when the requested task matches the workflow below.

## Inputs

Identify the inputs and constraints explicitly named in the workflow. If a required input is missing, ask for it before starting. Do not invent requirements, tools, access, or expected results.

## Workflow

Follow these user-provided instructions in order and preserve their meaning:

${workflowSteps(workflow)}

## Verification

Check the completed work against every outcome and constraint stated in the workflow. Report anything that could not be completed or verified.
`;
  return [{ path: "SKILL.md", content }];
}
