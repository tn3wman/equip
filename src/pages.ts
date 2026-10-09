import {
  Activity,
  BookOpen,
  Compass,
  FileText,
  GitBranch,
  Laptop,
  Settings2,
  type LucideIcon,
} from "lucide-react";

/* The dashboard's routed pages: one source for the sidebar, the breadcrumb,
   and the command palette. The editor is reachable but not listed. */
export const pageMeta = [
  { id: "library", label: "Skill library", icon: BookOpen },
  { id: "instructions", label: "Instructions", icon: FileText },
  { id: "discover", label: "Discover", icon: Compass },
  { id: "devices", label: "Computers", icon: Laptop },
  { id: "changes", label: "Changes", icon: GitBranch },
  { id: "activity", label: "Activity", icon: Activity },
  { id: "settings", label: "Settings", icon: Settings2 },
] as const satisfies readonly { id: string; label: string; icon: LucideIcon }[];

export type Page = (typeof pageMeta)[number]["id"] | "editor";

export const isPage = (value: string): value is Page =>
  value === "editor" || pageMeta.some((page) => page.id === value);

export const pageTitle = (page: Page) =>
  page === "editor" ? "Skill editor" : pageMeta.find((entry) => entry.id === page)!.label;
