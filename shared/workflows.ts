import type { Skill } from "./types.ts";

export interface WorkflowCollection {
  id: string;
  label: string;
  purpose: string;
  query: string;
}

// Collections are search entry points into skills.sh. They do not imply a
// curated package list or fixed catalog membership.
export const workflowCollections: WorkflowCollection[] = [
  { id: "design", label: "Design interfaces", purpose: "UI critique, design systems, and frontend implementation", query: "frontend design" },
  { id: "testing", label: "Test software", purpose: "Browser checks, test plans, and regression investigation", query: "testing browser" },
  { id: "backend", label: "Build backends", purpose: "APIs, databases, and service architecture", query: "backend api database" },
  { id: "automation", label: "Automate work", purpose: "Repeatable tasks, scripts, and connected tools", query: "automation workflow" },
  { id: "security", label: "Review security", purpose: "Threat analysis, code review, and hardening", query: "security review" },
  { id: "writing", label: "Write and document", purpose: "Technical writing, documentation, and editing", query: "documentation writing" },
];

const generic = new Set([
  "agent", "agents", "skill", "skills", "tool", "tools", "with", "from",
  "your", "into", "using", "helps", "help", "code", "work", "workflow",
]);

function words(value: string) {
  return new Set(value.toLowerCase().split(/[^a-z0-9]+/)
    .filter(word => word.length >= 4 && !generic.has(word)));
}

export function skillSourceKey(skill: Pick<Skill, "source" | "name">) {
  let source = skill.source.trim().toLowerCase().replace(/\.git$/, "").replace(/^git\+/, "");
  source = source.replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/^git@github\.com:/, "");
  source = source.split("@")[0].replace(/^\/+|\/+$/g, "");
  return `${source}:${skill.name.trim().toLowerCase()}`;
}

/** Returns a cautious wording hint, never an executable-duplicate claim. */
export function findWorkflowOverlap(candidate: Skill, selected: Skill[]) {
  const titleWords = words(`${candidate.name} ${candidate.title}`);
  const descriptionWords = words(candidate.description);
  for (const existing of selected) {
    if (skillSourceKey(candidate) === skillSourceKey(existing)) continue;
    const existingTitles = words(`${existing.name} ${existing.title}`);
    const titleOverlap = [...titleWords].filter(word => existingTitles.has(word));
    if (titleOverlap.length >= 2) return existing;
    const existingDescription = words(existing.description);
    const descriptionOverlap = [...descriptionWords].filter(word => existingDescription.has(word));
    if (descriptionOverlap.length >= 4) return existing;
  }
  return undefined;
}
