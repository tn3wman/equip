export type SyncStatus =
  | "synchronized"
  | "pending"
  | "offline"
  | "conflicted"
  | "failed";
export interface SkillFile {
  path: string;
  content: string;
  encoding?: "base64";
  mode?: number;
}
export interface Version {
  id: string;
  revision: string;
  createdAt: string;
  message: string;
  files: SkillFile[];
}
export interface Target {
  deviceId: string;
  agent: string;
  profile?: string;
  project?: string;
  enabled: boolean;
}
export interface SkillAudit {
  provider: string;
  slug: string;
  status: "pass" | "warn" | "fail" | "unknown";
  summary: string;
  auditedAt?: string;
  riskLevel?: string;
  categories?: string[];
  url: string;
}
export interface SkillSafety {
  status: "pass" | "warn" | "fail" | "unscanned" | "unavailable";
  audits: SkillAudit[];
  checkedAt: string;
  url?: string;
  error?: string;
  // Reports concern the upstream skill. They do not attest to Equip's pinned revision.
  scope: "upstream";
}
export type DiscoveryView = "all-time" | "trending" | "hot" | "official";
export interface DiscoveryResult {
  skills: Skill[];
  live: boolean;
  error?: string;
  pagination?: { page: number; perPage: number; total: number; hasMore: boolean };
}
export interface Skill {
  id: string;
  name: string;
  title: string;
  description: string;
  author: string;
  source: string;
  kind: "third-party" | "custom";
  category: string;
  icon: string;
  color: string;
  selected: boolean;
  enabled: boolean;
  autoUpdate: boolean;
  revision: string;
  upstreamRevision?: string;
  versions: Version[];
  files: SkillFile[];
  draft?: SkillFile[];
  requirements: string[];
  targets: Target[];
  installs?: number;
  catalogId?: string;
  catalogUrl?: string;
  sourceType?: string;
  official?: boolean;
  duplicate?: boolean;
  safety?: SkillSafety;
  updatedAt: string;
  localOrigin?: { deviceId: string; path: string };
}
export interface Agent {
  id: string;
  name: string;
  path: string;
  profile?: string;
  project?: string;
  aliases?: Array<{ profile: string; path: string }>;
}
export interface Receipt {
  skillId: string;
  agent: string;
  profile?: string;
  project?: string;
  revision: string;
  status: SyncStatus;
  message?: string;
  path?: string;
  timestamp: string;
  localFiles?: SkillFile[];
  managed?: boolean;
}
export interface Device {
  id: string;
  name: string;
  os: string;
  arch: string;
  online: boolean;
  lastSeen: string;
  lastSync?: string;
  appliedGeneration?: number;
  agents: Agent[];
  receipts: Receipt[];
  demo?: boolean;
  disconnect?: "retain" | "remove";
  disconnectedAt?: string;
  resolutions?: Record<string, "replace" | "preserve" | "import">;
  localSync?: { enabled: boolean; path?: string; lastImport?: string; error?: string };
}
export interface Activity {
  id: string;
  type: string;
  title: string;
  description: string;
  timestamp: string;
  status: SyncStatus;
  deviceId?: string;
  skillId?: string;
}
export interface SourceRequest {
  id: string;
  source: string;
  name?: string;
  kind: "install" | "import";
  skillId?: string;
  reason?: string;
  auditAcknowledged?: boolean;
  automatic?: boolean;
}
export interface Workspace {
  name: string;
  email: string;
  demo: boolean;
  skills: Skill[];
  devices: Device[];
  activity: Activity[];
  generation: number;
  sourceRequests?: SourceRequest[];
  compatibility?: { version: string; count: number; checkedAt: string };
}
export interface DesiredState {
  generation: number;
  skills: Skill[];
  sourceRequests?: SourceRequest[];
  resolutions: Record<string, "replace" | "preserve" | "import">;
  disconnect?: "retain" | "remove";
  localSync?: boolean;
  localSkills?: Array<Pick<Skill, "id" | "name" | "revision" | "kind">>;
}
export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}
