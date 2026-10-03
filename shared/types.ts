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
  updatedAt: string;
}
export interface Agent {
  id: string;
  name: string;
  path: string;
  profile?: string;
  project?: string;
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
}
export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}
