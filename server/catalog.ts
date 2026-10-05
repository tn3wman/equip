import type { Skill } from "../shared/types.ts";

const now = "2026-09-28T14:00:00.000Z";

function sampleFile(name: string, description: string, title: string) {
  return {
    path: "SKILL.md",
    content: `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${title}\n\nThis is a sample preview for the Equip demo. Inspect the source to load the current published files before installation.\n`,
  };
}

const entries = [
  {
    name: "vercel-react-best-practices",
    title: "React best practices",
    description: "Performance guidance for React and Next.js applications.",
    author: "Vercel",
    source: "vercel-labs/agent-skills",
    category: "Development",
    icon: "react",
    color: "lavender",
    installs: undefined,
  },
  {
    name: "web-design-guidelines",
    title: "Web design guidelines",
    description:
      "Review interfaces for accessibility and web design standards.",
    author: "Vercel",
    source: "vercel-labs/agent-skills",
    category: "Design",
    icon: "design",
    color: "blue",
    installs: undefined,
  },
  {
    name: "frontend-design",
    title: "Frontend design",
    description:
      "Build distinctive production interfaces with deliberate visual choices.",
    author: "Anthropic",
    source: "anthropics/skills",
    category: "Design",
    icon: "design",
    color: "pink",
    installs: undefined,
  },
  {
    name: "skill-creator",
    title: "Skill creator",
    description:
      "Create and refine reusable agent skills with supporting resources.",
    author: "Anthropic",
    source: "anthropics/skills",
    category: "Development",
    icon: "document",
    color: "peach",
    installs: undefined,
  },
  {
    name: "find-skills",
    title: "Find skills",
    description: "Discover installable skills for a task or workflow.",
    author: "Vercel",
    source: "vercel-labs/skills",
    category: "Productivity",
    icon: "browser",
    color: "green",
    installs: undefined,
  },
  {
    name: "agent-browser",
    title: "Agent browser",
    description:
      "Automate browser navigation, forms, screenshots, and page inspection.",
    author: "Vercel",
    source: "vercel-labs/agent-browser",
    category: "Automation",
    icon: "browser",
    color: "yellow",
    installs: undefined,
  },
  {
    name: "code-review",
    title: "Code review",
    description:
      "Review a change for correctness, security, and maintainability.",
    author: "Equip Demo",
    source: "custom",
    category: "Development",
    icon: "security",
    color: "lavender",
    installs: undefined,
  },
  {
    name: "release-notes",
    title: "Release notes",
    description: "Turn shipped changes into concise customer release notes.",
    author: "Equip Demo",
    source: "custom",
    category: "Writing",
    icon: "document",
    color: "peach",
    installs: undefined,
  },
];

export const demoCatalog: Skill[] = entries.map((entry, index) => {
  const files = [sampleFile(entry.name, entry.description, entry.title)];
  return {
    id: `catalog-${entry.name}`,
    ...entry,
    kind: entry.source === "custom" ? "custom" : "third-party",
    selected: false,
    enabled: true,
    autoUpdate: false,
    revision: `sample-${index + 1}`,
    versions: [],
    files,
    requirements: [],
    targets: [],
    updatedAt: now,
  } satisfies Skill;
});
