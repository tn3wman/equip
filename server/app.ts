import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import cookieParser from "cookie-parser";
import compression from "compression";
import YAML from "yaml";
import type {
  Activity,
  DesiredState,
  SkillSafety,
  DiscoveryView,
  Device,
  InstructionLocation,
  Instructions,
  Receipt,
  Skill,
  SkillFile,
  SourceRequest,
  Target,
  Workspace,
} from "../shared/types.ts";
import { instructionEnabled, instructionKey } from "../shared/instructions.ts";
import { discoverSkills, fetchSkillSafety } from "../shared/discovery.ts";
import { skillArchive } from "../shared/archive.ts";
import { demoCatalog } from "./catalog.ts";
import {
  configuredPublicUrl as resolveConfiguredPublicUrl,
  runtimeConfig,
} from "./config.ts";
import { powershellInstaller, shellInstaller } from "./installers.ts";
import { buildSkillDraft } from "./skill-draft.ts";
import { openStore, transactionalStore, lockAccount, type Store } from "./storage.ts";
import { registerEmailAuth, type SendSignIn } from "./email-auth.ts";
import {
  canonicalFiles,
  librarySnapshotRevision,
  skillRevision,
  type LibrarySnapshotSkill,
} from "../shared/library.ts";

import { readWorkspace, writeWorkspace, migrateWorkspaces } from "./workspace-store.ts";
import { PersistentRateLimiter, rateLimitKey } from "./rate-limit.ts";
import { hasMergeMarkers } from "../shared/merge.ts";
import { registerAccountRoutes } from "./account.ts";
import { createReleaseManifest, npmPackageIntegrity } from "./release.ts";

const scrypt = promisify(crypto.scrypt);
const SESSION_COOKIE = "equip_session";
const DAY = 86_400_000;
const iso = () => new Date().toISOString();
const id = (prefix: string) =>
  `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
const digest = (value: string | Buffer) =>
  crypto.createHash("sha256").update(value).digest("hex");
const clone = <T>(value: T): T => structuredClone(value);

type AuthedRequest = Request & {
  accountId?: string;
  workspace?: Workspace;
  demo?: boolean;
  deviceId?: string;
};

async function passwordHash(
  password: string,
  salt = crypto.randomBytes(16).toString("hex"),
) {
  const hash = ((await scrypt(password, salt, 64)) as Buffer).toString("hex");
  return `scrypt$${salt}$${hash}`;
}
async function passwordMatches(password: string, encoded: string) {
  const [, salt, expected] = encoded.split("$");
  if (!salt || !expected) return false;
  const actual = (await scrypt(password, salt, 64)) as Buffer;
  return crypto.timingSafeEqual(actual, Buffer.from(expected, "hex"));
}

function seedDemo(): Workspace {
  const selected = demoCatalog.map((skill, i) => ({
    ...clone(skill),
    selected: true,
    revision: `demo-${i + 1}`,
    versions: [
      {
        id: `version-${i}`,
        revision: `demo-${i + 1}`,
        createdAt: nowAgo(i + 2),
        message: "Installed from the demo catalog",
        files: clone(skill.files),
      },
    ],
  }));
  selected[1].upstreamRevision = "demo-9";
  selected[3].upstreamRevision = "demo-10";
  const devices: Device[] = [
    {
      id: "demo-mac",
      name: "MacBook Pro",
      os: "darwin",
      arch: "arm64",
      online: true,
      lastSeen: nowAgo(0),
      lastSync: nowAgo(0),
      appliedGeneration: 5,
      demo: true,
      agents: [
        { id: "claude-code", name: "Claude Code", path: "~/.claude/skills" },
        { id: "codex", name: "Codex", path: "~/.codex/skills" },
      ],
      receipts: [],
    },
    {
      id: "demo-linux",
      name: "Linux workstation",
      os: "linux",
      arch: "x64",
      online: true,
      lastSeen: nowAgo(1),
      lastSync: nowAgo(1),
      appliedGeneration: 5,
      demo: true,
      agents: [{ id: "codex", name: "Codex", path: "~/.codex/skills" }],
      receipts: [],
    },
    {
      id: "demo-thinkpad",
      name: "ThinkPad",
      os: "windows",
      arch: "x64",
      online: false,
      lastSeen: nowAgo(60 * 30),
      lastSync: nowAgo(60 * 45),
      demo: true,
      agents: [
        {
          id: "claude-code",
          name: "Claude Code",
          path: "%USERPROFILE%\\.claude\\skills",
        },
      ],
      receipts: [],
    },
  ];
  for (const device of devices.slice(0, 2))
    device.receipts = selected.flatMap((skill) =>
      device.agents.map((agent) => ({
        skillId: skill.id,
        agent: agent.id,
        profile: agent.profile,
        project: agent.project,
        revision: skill.revision,
        status: "synchronized" as const,
        timestamp: device.lastSync!,
      })),
    );
  devices[2].receipts = selected.flatMap((skill) =>
    devices[2].agents.map((agent) => ({
      skillId: skill.id,
      agent: agent.id,
      profile: agent.profile,
      project: agent.project,
      revision: skill.revision,
      status: "offline" as const,
      timestamp: devices[2].lastSeen,
    })),
  );
  return {
    name: "Equip Demo",
    email: "demo@equip.local",
    demo: true,
    skills: selected,
    devices,
    generation: 5,
    activity: [
      {
        id: "demo-a1",
        type: "sync",
        title: "Skills synchronized",
        description: "MacBook Pro installed 8 skills.",
        timestamp: nowAgo(0),
        status: "synchronized",
        deviceId: "demo-mac",
      },
      {
        id: "demo-a2",
        type: "device",
        title: "Linux workstation connected",
        description: "Codex is ready to receive skills.",
        timestamp: nowAgo(1),
        status: "synchronized",
        deviceId: "demo-linux",
      },
    ],
  };
}
function nowAgo(minutes: number) {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}
function emptyWorkspace(name: string, email: string): Workspace {
  return {
    name,
    email,
    demo: false,
    skills: [],
    instructions: [],
    devices: [],
    activity: [],
    generation: 0,
  };
}

async function saveWorkspace(
  db: Store,
  accountId: string,
  workspace: Workspace,
) {
  await writeWorkspace(db, accountId, workspace);
}

function parseWorkspace(value: string): Workspace {
  const workspace: Workspace & { librarySource?: unknown } = JSON.parse(value);
  let migrated = Boolean(workspace.librarySource);
  delete workspace.librarySource;
  workspace.instructions ??= [];
  for (const document of workspace.instructions) {
    if (document.filename === "AGENTS.md" && document.scope === "global") continue;
    document.filename = "AGENTS.md";
    document.scope = "global";
    const normalize = (files: SkillFile[]) => files.map(file => ({ ...file, path: "AGENTS.md" }));
    document.files = normalize(document.files);
    if (document.draft) document.draft = normalize(document.draft);
    document.versions = document.versions.map(version => {
      const files = normalize(version.files);
      return { ...version, files, revision: revision(files) };
    });
    if (document.files.length) document.revision = revision(document.files);
    migrated = true;
  }
  for (const skill of workspace.skills) {
    const legacy = skill as Skill & { librarySourceId?: string };
    if (legacy.librarySourceId) migrated = true;
    delete legacy.librarySourceId;
  }
  // Imported instructions and history stay intact. Equip now owns every revision.
  if (migrated) bump(workspace);
  return workspace;
}
function activity(
  workspace: Workspace,
  item: Omit<Activity, "id" | "timestamp">,
) {
  workspace.activity.unshift({ id: id("activity"), timestamp: iso(), ...item });
  workspace.activity = workspace.activity.slice(0, 100);
}
function bump(workspace: Workspace) {
  workspace.generation += 1;
}
function sameDestination(
  target: Target,
  agent: { id?: string; agent?: string; profile?: string; project?: string },
) {
  return (
    target.agent === (agent.id ?? agent.agent) &&
    (!target.profile || target.profile === agent.profile) &&
    (!target.project || target.project === agent.project)
  );
}
const resolutionKey = (
  skillId: string,
  agent: string,
  profile?: string,
  project?: string,
) => [skillId, agent, profile ?? "", project ?? ""].join(":");

function validateReceipts(receipts: unknown): asserts receipts is Receipt[] {
  if (!Array.isArray(receipts))
    throw httpError(400, "receipts must be an array.");
  const statuses = new Set([
    "synchronized",
    "pending",
    "offline",
    "conflicted",
    "failed",
  ]);
  for (const receipt of receipts) {
    if (
      !receipt ||
      (receipt.kind !== undefined && receipt.kind !== "instructions") ||
      typeof receipt.skillId !== "string" ||
      typeof receipt.agent !== "string" ||
      typeof receipt.revision !== "string" ||
      !statuses.has(receipt.status) ||
      typeof receipt.timestamp !== "string" ||
      Number.isNaN(Date.parse(receipt.timestamp))
    )
      throw httpError(400, "A receipt has invalid fields.");
    if (receipt.localFiles !== undefined)
      receipt.kind === "instructions"
        ? validateInstructionReceiptFiles(receipt.localFiles)
        : validateFileEntries(receipt.localFiles);
    if (receipt.managed !== undefined && typeof receipt.managed !== "boolean")
      throw httpError(400, "A receipt has invalid managed state.");
  }
}

function validateInstructionFiles(files: unknown, filename?: unknown): asserts files is SkillFile[] {
  if (!Array.isArray(files) || files.length !== 1)
    throw httpError(400, "Instructions require exactly one file.");
  const file = files[0] as SkillFile;
  if (!file || (file.path !== "CLAUDE.md" && file.path !== "AGENTS.md") ||
      (filename !== undefined && file.path !== filename) || typeof file.content !== "string" ||
      file.encoding !== undefined || file.content.includes("\0") ||
      (file.mode !== undefined && (!Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777)))
    throw httpError(400, "Instructions must be one plain UTF-8 CLAUDE.md or AGENTS.md file.");
  if (Buffer.byteLength(file.content, "utf8") > 256 * 1024)
    throw httpError(413, "Instructions exceed the 256 KiB limit.");
}

function validateInstructionReceiptFiles(files: unknown, filename?: unknown): asserts files is SkillFile[] {
  if (Array.isArray(files) && files.length === 0) return;
  validateInstructionFiles(files, filename);
}

function canonicalInstructionFiles(files: SkillFile[]): SkillFile[] {
  return files.map(file => ({ ...file, path: "AGENTS.md" }));
}

function validateInstructionLocations(value: unknown): InstructionLocation[] {
  if (!Array.isArray(value) || value.length > 200)
    throw httpError(400, "instructionLocations must be an array of at most 200 locations.");
  const valid = (item: unknown, limit: number) => typeof item === "string" && item.length > 0 && item.length <= limit;
  return value.map((raw: any) => {
    if (!raw || !valid(raw.agent, 120) || !valid(raw.path, 2048) ||
        typeof raw.filename !== "string" || raw.filename.length > 255 ||
        !/^[^/\\\0]+\.md$/i.test(raw.filename) || raw.filename === ".md" ||
        (raw.profile !== undefined && !valid(raw.profile, 200)) ||
        (raw.project !== undefined && !valid(raw.project, 2048)) ||
        (raw.warning !== undefined && typeof raw.warning !== "string"))
      throw httpError(400, "An instruction location has invalid fields.");
    if (raw.localFiles !== undefined) validateInstructionReceiptFiles(raw.localFiles, "AGENTS.md");
    return {
      agent: raw.agent, filename: raw.filename, path: raw.path,
      ...(raw.profile ? { profile: raw.profile } : {}),
      ...(raw.project ? { project: raw.project } : {}),
      ...(raw.warning ? { warning: raw.warning.slice(0, 1000) } : {}),
      ...(raw.localFiles ? { localFiles: clone(raw.localFiles) } : {}),
    };
  });
}

function validateInstructionUnavailable(value: unknown) {
  if (!Array.isArray(value) || value.length > 100)
    throw httpError(400, "instructionUnavailable must be an array of at most 100 entries.");
  return value.map((raw: any) => {
    if (!raw || typeof raw.agent !== "string" || !raw.agent || raw.agent.length > 120 ||
        typeof raw.reason !== "string" || !raw.reason || raw.reason.length > 1000)
      throw httpError(400, "An unavailable instruction adapter has invalid fields.");
    if ((raw.profile !== undefined && (typeof raw.profile !== "string" || raw.profile.length > 200)) || (raw.project !== undefined && (typeof raw.project !== "string" || raw.project.length > 2048))) throw httpError(400, "Invalid instruction configuration.");
    return { agent: raw.agent, reason: raw.reason, ...(raw.profile ? {profile:raw.profile} : {}), ...(raw.project ? {project:raw.project} : {}) };
  });
}

function validateInstructionTargets(value: unknown): Target[] {
  if (!Array.isArray(value) || value.length > 500)
    throw httpError(400, "targets must be an array of at most 500 targets.");
  return value.map((raw: any) => {
    if (!raw || typeof raw.deviceId !== "string" || !raw.deviceId ||
        raw.deviceId.length > 200 || typeof raw.agent !== "string" || !raw.agent || raw.agent.length > 120 ||
        typeof raw.enabled !== "boolean" ||
        (raw.profile !== undefined && (typeof raw.profile !== "string" || !raw.profile || raw.profile.length > 200)) ||
        (raw.project !== undefined && (typeof raw.project !== "string" || !raw.project || raw.project.length > 2048)))
      throw httpError(400, "An instruction target has invalid fields.");
    return { deviceId: raw.deviceId, agent: raw.agent, enabled: raw.enabled,
      ...(raw.profile ? { profile: raw.profile } : {}), ...(raw.project ? { project: raw.project } : {}) };
  });
}

function validateAgents(agents: unknown): asserts agents is Device["agents"] {
  if (!Array.isArray(agents) || agents.length > 100)
    throw httpError(400, "agents must be an array of at most 100 agents.");
  const valid = (value: unknown, limit: number) =>
    typeof value === "string" && value.length > 0 && value.length <= limit;
  for (const agent of agents) {
    if (!agent || !valid(agent.id, 120) || !valid(agent.name, 200) || !valid(agent.path, 2048))
      throw httpError(400, "An agent has invalid fields.");
    if (agent.profile !== undefined && !valid(agent.profile, 200))
      throw httpError(400, "An agent has an invalid profile.");
    if (agent.project !== undefined && !valid(agent.project, 2048))
      throw httpError(400, "An agent has an invalid project.");
    if (agent.detection !== undefined && !["installation", "configuration"].includes(agent.detection)) throw httpError(400, "Invalid agent detection evidence.");
    if (agent.detectionPath !== undefined && !valid(agent.detectionPath, 2048)) throw httpError(400, "Invalid agent detection path.");
    if (agent.aliases !== undefined) {
      if (!Array.isArray(agent.aliases) || agent.aliases.length > 50)
        throw httpError(400, "Agent aliases must be an array of at most 50 aliases.");
      for (const alias of agent.aliases)
        if (!alias || !valid(alias.profile, 200) || !valid(alias.path, 2048))
          throw httpError(400, "An agent alias has invalid fields.");
    }
  }
}

function validateFileEntries(files: unknown): asserts files is SkillFile[] {
  if (!Array.isArray(files)) throw httpError(400, "files must be an array.");
  const paths = new Set<string>();
  let decodedBytes = 0;
  for (const file of files) {
    if (
      !file ||
      typeof file.path !== "string" ||
      typeof file.content !== "string" ||
      !file.path ||
      file.path.includes("\\") ||
      path.posix.isAbsolute(file.path) ||
      file.path
        .split("/")
        .some((part: string) => part === ".." || part === "." || part === "")
    )
      throw httpError(400, `Unsafe skill path: ${file?.path ?? ""}`);
    if (file.encoding !== undefined && file.encoding !== "base64")
      throw httpError(400, `Invalid encoding for ${file.path}.`);
    if (
      file.encoding === "base64" &&
      (file.content.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(file.content))
    )
      throw httpError(400, `Invalid base64 content for ${file.path}.`);
    if (
      file.mode !== undefined &&
      (!Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777)
    )
      throw httpError(400, `Invalid mode for ${file.path}.`);
    if (paths.has(file.path))
      throw httpError(400, `Duplicate skill path: ${file.path}`);
    paths.add(file.path);
    decodedBytes +=
      file.encoding === "base64"
        ? Buffer.from(file.content, "base64").byteLength
        : Buffer.byteLength(file.content);
    if (decodedBytes > 25 * 1024 * 1024)
      throw httpError(413, "Skill files exceed the 25 MiB limit.");
  }
  for (const filePath of paths) {
    const parts = filePath.split("/");
    for (let i = 1; i < parts.length; i++)
      if (paths.has(parts.slice(0, i).join("/")))
        throw httpError(400, `A file conflicts with a directory: ${filePath}`);
  }
}
function validateFiles(files: SkillFile[], descriptionLimit = 1024) {
  validateFileEntries(files);
  if (files.length === 0)
    throw httpError(400, "A skill needs at least one file.");
  const primary = files.find((file) => file.path === "SKILL.md");
  if (!primary || primary.encoding === "base64")
    throw httpError(400, "SKILL.md is required and must contain text.");
  const match = primary.content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw httpError(400, "SKILL.md needs YAML frontmatter.");
  let frontmatter: unknown;
  try {
    frontmatter = YAML.parse(match[1]);
  } catch {
    throw httpError(400, "SKILL.md has invalid YAML frontmatter.");
  }
  const name =
    frontmatter && typeof frontmatter === "object"
      ? (frontmatter as any).name
      : undefined;
  const description =
    frontmatter && typeof frontmatter === "object"
      ? (frontmatter as any).description
      : undefined;
  if (
    typeof name !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ||
    name.length > 64
  )
    throw httpError(
      400,
      "Frontmatter name must be 1–64 lowercase letters, numbers, or hyphen-separated words.",
    );
  if (
    typeof description !== "string" ||
    !description.trim() ||
    description.length > descriptionLimit
  )
    throw httpError(
      400,
      `Frontmatter description must be 1–${descriptionLimit} characters.`,
    );
  return { name, description: description.trim() };
}
function revision(files: SkillFile[]) {
  return skillRevision(files);
}
function sameFiles(left: SkillFile[], right: SkillFile[]) {
  return canonicalFiles(left) === canonicalFiles(right);
}

function validateLibrarySnapshot(body: unknown): {
  id: string;
  name: string;
  revision: string;
  skills: LibrarySnapshotSkill[];
} {
  const input = body as any;
  if (!input || typeof input.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.id) || input.id.length > 64)
    throw httpError(400, "Library id must be 1–64 lowercase letters, numbers, or hyphen-separated words.");
  if (
    typeof input.name !== "string" ||
    !input.name.trim() ||
    input.name.length > 120
  )
    throw httpError(400, "Library name must be 1–120 characters.");
  if (typeof input.revision !== "string" || !/^[a-f0-9]{64}$/.test(input.revision))
    throw httpError(400, "Library revision must be a lowercase SHA-256 hash.");
  if (!Array.isArray(input.skills) || input.skills.length > 200)
    throw httpError(400, "Library skills must be an array of at most 200 skills.");
  const names = new Set<string>();
  let decodedBytes = 0;
  const skills = input.skills.map((item: any): LibrarySnapshotSkill => {
    if (
      !item ||
      typeof item.name !== "string" ||
      typeof item.title !== "string" ||
      !item.title.trim() ||
      item.title.length > 200 ||
      typeof item.source !== "string" ||
      !item.source ||
      item.source.length > 2048 ||
      (item.kind !== "custom" && item.kind !== "third-party")
    )
      throw httpError(400, "A library skill has invalid fields.");
    const metadata = validateFiles(item.files, 16_384);
    if (metadata.name !== item.name)
      throw httpError(400, `Skill ${item.name} does not match its frontmatter name.`);
    if (names.has(item.name))
      throw httpError(400, `Duplicate library skill name: ${item.name}`);
    names.add(item.name);
    for (const file of item.files as SkillFile[])
      decodedBytes +=
        file.encoding === "base64"
          ? Buffer.from(file.content, "base64").byteLength
          : Buffer.byteLength(file.content);
    if (decodedBytes > 50 * 1024 * 1024)
      throw httpError(413, "Library files exceed the 50 MiB limit.");
    return {
      name: item.name,
      title: item.title.trim(),
      source: item.source,
      kind: item.kind,
      files: clone(item.files),
    };
  });
  if (librarySnapshotRevision(skills) !== input.revision)
    throw httpError(400, "Library revision does not match its skills.");
  return { id: input.id, name: input.name.trim(), revision: input.revision, skills };
}
function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

async function upstream() {
  return import("../shared/upstream.ts");
}

export async function createApp(
  options: {
    dataDir?: string;
    publicDir?: string;
    autoUpdateIntervalMs?: number;
    sourceResolver?: (source: string, name?: string) => Promise<any>;
    safetyResolver?: (source: string, name: string) => Promise<SkillSafety>;
    publicUrl?: string;
    registrationEmail?: string;
    databaseUrl?: string;
    databaseCa?: string;
    emailAuthEnabled?: boolean;
    sendSignIn?: SendSignIn;
  } = {},
) {
  const registrationEmail = (
    options.registrationEmail ?? process.env.EQUIP_REGISTRATION_EMAIL
  )
    ?.trim()
    .toLowerCase();
  let configuredPublicUrl: string | undefined;
  const publicUrlInput = resolveConfiguredPublicUrl(options.publicUrl);
  if (publicUrlInput) {
    let parsed: URL;
    try {
      parsed = new URL(publicUrlInput);
    } catch {
      throw new Error("EQUIP_PUBLIC_URL must be a valid HTTP(S) URL.");
    }
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    )
      throw new Error(
        "EQUIP_PUBLIC_URL must be an HTTP(S) origin without credentials, a path, query, or fragment.",
      );
    configuredPublicUrl = parsed.origin;
  }
  const emailAuthEnabled =
    options.emailAuthEnabled ?? Boolean(options.sendSignIn || process.env.EQUIP_RESEND_API_KEY);
  if (emailAuthEnabled && process.env.NODE_ENV === "production" && !configuredPublicUrl) throw new Error("Hosted email authentication requires a configured public origin.");
  const dataDir = options.dataDir ?? runtimeConfig().dataDir;
  const db = transactionalStore(await openStore({
    dataDir,
    databaseUrl: options.databaseUrl ?? process.env.EQUIP_DATABASE_URL,
    databaseCa: options.databaseCa ?? process.env.EQUIP_DATABASE_CA,
  }));
  await migrateWorkspaces(db);
  const runAccountLocked = async <T>(accountId: string, work: () => Promise<T> | T): Promise<T> =>
    db.transaction(async transaction => {
      if (!(await lockAccount(transaction, accountId))) throw httpError(401, "authentication_required");
      return work();
    });
  const limiter = new PersistentRateLimiter(db);
  const limitAuth = async (req: Request, res: Response, namespace: string, limit: number, window = 10 * 60_000) => {
    const result = await limiter.consume(rateLimitKey(namespace, req.ip ?? "unknown"), limit, window);
    if (result.allowed) return true;
    res.set("Retry-After", String(result.retryAfterSeconds));
    res.status(429).json({error: "Too many attempts. Try again in a few minutes."});
    return false;
  };
  const app = express();
  app.disable("x-powered-by");
  if (process.env.RAILWAY_ENVIRONMENT_ID) app.set("trust proxy", 1);
  app.use(compression());
  app.use(express.json({ limit: "72mb" }));
  app.use(cookieParser());
  app.get("/api/health", async (_req, res) => {
    try {
      await db.get("SELECT 1");
      res.json({ status: "ok" });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });
  const publicOrigin = (req: Request) =>
    configuredPublicUrl ?? `${req.protocol}://${req.get("host")}`;

  const createSession = async (
    res: Response,
    accountId: string | null,
    demo = false,
  ) => {
    const token = crypto.randomBytes(32).toString("base64url");
    await db.run("DELETE FROM sessions WHERE expires_at<=?", Date.now());
    await db.run(
      "INSERT INTO sessions(token_hash,account_id,demo,expires_at) VALUES(?,?,?,?)",
      digest(token),
      accountId,
      demo ? 1 : 0,
      Date.now() + 30 * DAY,
    );
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure:
        process.env.EQUIP_SECURE_COOKIES === "1" ||
        configuredPublicUrl?.startsWith("https://") === true,
      maxAge: 30 * DAY,
      path: "/",
    });
  };
  const auth =
    (allowAutoDemo = false) =>
    async (req: AuthedRequest, res: Response, next: NextFunction) => {
      const token = req.cookies?.[SESSION_COOKIE];
      const session = token
        ? await db.get<any>(
            "SELECT * FROM sessions WHERE token_hash=? AND expires_at>?",
            digest(token),
            Date.now(),
          )
        : undefined;
      if (session?.demo) {
        req.demo = true;
        req.workspace = seedDemo();
        return next();
      }
      if (session?.account_id) {
        const account = await db.get<any>(
          "SELECT workspace FROM accounts WHERE id=?",
          session.account_id,
        );
        if (account) {
          req.accountId = session.account_id;
          req.workspace = parseWorkspace(await readWorkspace(db, req.accountId!, account.workspace, req.path === "/api/workspace" && req.query.view === "dashboard"));
          return next();
        }
      }
      if (allowAutoDemo) {
        await createSession(res, null, true);
        req.demo = true;
        req.workspace = seedDemo();
        return next();
      }
      res.status(401).json({ error: "authentication_required" });
    };
  const persist = async (req: AuthedRequest) => {
    if (req.accountId && req.workspace)
      await saveWorkspace(db, req.accountId, req.workspace);
  };
  const writable = (req: AuthedRequest) => {
    if (req.demo)
      throw httpError(
        403,
        "The demo workspace is read-only. Create an account to make changes.",
      );
  };

  registerAccountRoutes(app, {
    store: db, auth: auth(false), runAccountLocked,
    loadWorkspace: async accountId => {
      const row = await db.get<{workspace:string}>("SELECT workspace FROM accounts WHERE id=?", accountId);
      return row ? parseWorkspace(await readWorkspace(db, accountId, row.workspace)) : undefined;
    },
  });
  await registerEmailAuth(app, {store: db, registrationEmail, publicOrigin, createSession, emptyWorkspace, enabled: emailAuthEnabled, send: options.sendSignIn});

  app.post("/api/auth/register", async (req, res, next) => {
    try {
      if (!(await limitAuth(req, res, req.path.endsWith("register") ? "password-register" : "password-login", req.path.endsWith("register") ? 10 : 30))) return;
      if (emailAuthEnabled)
        throw httpError(403, "Use your email sign-in link to continue.");
      const { name, email, password } = req.body ?? {};
      if (
        typeof name !== "string" ||
        !name.trim() ||
        typeof email !== "string" ||
        !email.includes("@") ||
        typeof password !== "string" ||
        password.length < 8 || password.length > 1024 || email.length > 254 || name.length > 120
      )
        throw httpError(
          400,
          "Name, a valid email, and a password of at least 8 characters are required.",
        );
      const normalizedEmail = email.trim().toLowerCase();
      if (registrationEmail && normalizedEmail !== registrationEmail)
        throw httpError(
          403,
          "This preview is limited to invited accounts.",
        );
      const accountId = id("account");
      await db.run(
        "INSERT INTO accounts VALUES(?,?,?,?,?,?)",
        accountId,
        name.trim(),
        normalizedEmail,
        await passwordHash(password),
        JSON.stringify(emptyWorkspace(name.trim(), normalizedEmail)),
        iso(),
      );
      await createSession(res, accountId);
      res
        .status(201)
        .json(
          JSON.parse(
            (
              (await db.get<any>(
                "SELECT workspace FROM accounts WHERE id=?",
                accountId,
              ))!
            ).workspace,
          ),
        );
    } catch (error: any) {
      if (error.code === "SQLITE_CONSTRAINT_UNIQUE" || error.code === "23505")
        next(httpError(409, "An account already exists for this email."));
      else next(error);
    }
  });
  app.post("/api/auth/login", async (req, res, next) => {
    try {
      if (!(await limitAuth(req, res, req.path.endsWith("register") ? "password-register" : "password-login", req.path.endsWith("register") ? 10 : 30))) return;
      if (emailAuthEnabled)
        throw httpError(403, "Use your email sign-in link to continue.");
      const loginEmail = String(req.body?.email ?? "").trim().toLowerCase();
      const loginPassword = String(req.body?.password ?? "");
      if (loginEmail.length > 254 || loginPassword.length > 1024) throw httpError(401, "Email or password is incorrect.");
      const addressLimit = await limiter.consume(rateLimitKey("password-login-email",loginEmail), 15, 10*60_000);
      if (!addressLimit.allowed) {res.set("Retry-After",String(addressLimit.retryAfterSeconds)); return res.status(429).json({error:"Too many attempts. Try again in a few minutes."});}
      const account = await db.get<any>(
        "SELECT * FROM accounts WHERE email=?",
        String(req.body?.email ?? "").trim().toLowerCase(),
      );
      if (
        !account ||
        !(await passwordMatches(
          String(req.body?.password ?? ""),
          account.password_hash,
        ))
      )
        throw httpError(401, "Email or password is incorrect.");
      await createSession(res, account.id);
      res.json(parseWorkspace(await readWorkspace(db, account.id, account.workspace)));
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/auth/demo", async (_req, res) => {
    await createSession(res, null, true);
    res.json(seedDemo());
  });
  app.post("/api/auth/logout", async (req, res) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token)
      await db.run("DELETE FROM sessions WHERE token_hash=?", digest(token));
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.json({ ok: true });
  });
  app.get("/api/workspace", auth(true), (req: AuthedRequest, res) => {
    const workspace = clone(req.workspace!);
    const cutoff = Date.now() - 2 * 60_000;
    workspace.devices.forEach((device) => {
      if (!device.demo)
        device.online =
          !device.disconnectedAt && Date.parse(device.lastSeen) >= cutoff;
    });
    // The dashboard uses history metadata; rollback reads immutable files on the server.
    if (req.query.view === "dashboard")
      for (const skill of [...workspace.skills, ...(workspace.retiredSkills ?? [])]) {
        skill.files = [];
        skill.draft = undefined;
        skill.versions = skill.versions.map(version => ({ ...version, files: [] }));
      }
    if (req.query.view === "dashboard")
      for (const document of [...(workspace.instructions ?? []), ...(workspace.retiredInstructions ?? [])]) {
        document.draft = undefined;
        document.versions = document.versions.map(version => ({ ...version, files: [] }));
      }
    res.json(workspace);
  });

  app.get("/api/discover", async (req, res, next) => {
    try {
      const query = String(req.query.q ?? "");
      const view = String(req.query.view ?? "all-time");
      const page = Number(req.query.page ?? 0);
      if (!["all-time", "trending", "hot", "official"].includes(view) || !Number.isInteger(page) || page < 0 || page > 10000 || query.length > 200)
        throw httpError(400, "Invalid discovery parameters.");
      res.json(await discoverSkills(query, view as DiscoveryView, page));
    } catch (error) { next(error); }
  });
  const resolveSafety = options.safetyResolver ?? fetchSkillSafety;
  app.get("/api/skills/audits", async (req, res, next) => {
    try {
      res.json(await resolveSafety(String(req.query.source ?? ""), String(req.query.name ?? "")));
    } catch (error) { next(error); }
  });
  const reviewSafety = async (source: string, name: string, acknowledged: unknown) => {
    const safety = await resolveSafety(source, name);
    if ((safety.status === "warn" || safety.status === "fail") && acknowledged !== true)
      throw httpError(409, "Upstream security reports contain findings. Inspect the reports and acknowledge them before installing or updating this skill.");
    return safety;
  };
  app.post(
    "/api/skills/inspect",
    auth(false),
    async (req: AuthedRequest, res, next) => {
      try {
        if (req.demo)
          throw httpError(403, "Create an account to inspect skill sources.");
        const source = String(req.body?.source ?? "");
        if (!source) throw httpError(400, "source is required.");
        const resolved = await resolveSource(source, req.body?.name);
        validateFiles(resolved.files, 16_384);
        res.json(resolved);
      } catch (error) {
        next(error);
      }
    },
  );

  const workspaceHandler = (handler: (req: AuthedRequest, res: Response, next: NextFunction) => unknown | Promise<unknown>, readOnly = false) =>
    async (req: AuthedRequest, res: Response, next: NextFunction) => {
      let body: unknown;
      let responseQueued = false;
      let failure: unknown;
      const json = res.json;
      // Publish the response only after the transaction commits. A disconnected
      // client never releases an in-progress database write.
      res.json = ((value: unknown) => { body = value; responseQueued = true; return res; }) as typeof res.json;
      try {
        writable(req);
        const operation = async () => {
          const row = await db.get<{workspace:string}>("SELECT workspace FROM accounts WHERE id=?", req.accountId!);
          req.workspace = parseWorkspace(await readWorkspace(db, req.accountId!, row!.workspace, ["/api/device/heartbeat", "/api/device/receipts", "/api/device/desired"].includes(req.path), true));
          await handler(req, res, error => { failure = error ?? new Error("Unexpected middleware continuation."); });
          if (failure) throw failure;
        };
        if (readOnly) await db.transaction(operation, { readOnly: true });
        else await runAccountLocked(req.accountId!, operation);
        res.json = json;
        if (responseQueued && !res.destroyed) res.json(body);
      } catch (error) { res.json = json; next(error); }
    };
  const mutate = (handler: (req: AuthedRequest) => unknown | Promise<unknown>) => [
    auth(false),
    workspaceHandler(async (req, res) => {
      writable(req);
      const value: any = await handler(req);
      await persist(req);
      if (value?.__status) res.status(value.__status).json(value.body);
      else res.json(value);
    }),
  ];
  const queueSource = (
    workspace: Workspace,
    source: string,
    name: string | undefined,
    kind: SourceRequest["kind"],
    skillId: string | undefined,
    reason: string,
  ) => {
    workspace.sourceRequests ??= [];
    const existing = workspace.sourceRequests.find(
      (request) =>
        request.source === source &&
        request.name === name &&
        request.kind === kind &&
        request.skillId === skillId,
    );
    const request = existing ?? {
      id: id("source"),
      source,
      name,
      kind,
      skillId,
      reason,
    };
    if (!existing) workspace.sourceRequests.push(request);
    activity(workspace, {
      type: "source",
      title: "Waiting for source access",
      description: "Waiting for a connected computer with source access.",
      status: "pending",
      skillId,
    });
    return {
      __status: 202,
      body: {
        pending: true,
        id: request.id,
        source,
        message: "Waiting for a connected computer with source access.",
      },
    };
  };
  const findSkill = (req: AuthedRequest) => {
    const skill = req.workspace!.skills.find((s) => s.id === req.params.id);
    if (!skill) throw httpError(404, "Skill not found.");
    return skill;
  };
  const findInstructions = (req: AuthedRequest) => {
    const document = (req.workspace!.instructions ?? []).find(item => item.id === req.params.id);
    if (!document) throw httpError(404, "Instructions not found.");
    return document;
  };
  const guardInstructionRevision = (document: Instructions, expected: unknown) => {
    if (expected !== undefined && expected !== document.revision)
      throw httpError(409, "The Equip revision changed. Review the instructions again.");
  };

  app.get("/api/instructions/:id", auth(true), (req: AuthedRequest, res, next) => {
    try { res.json((req.workspace!.instructions ?? []).find(item => item.id === req.params.id) ?? req.workspace!.retiredInstructions?.find(item => item.id === req.params.id) ?? findInstructions(req)); } catch (error) { next(error); }
  });
  app.post("/api/instructions", ...mutate((req) => {
    const { title, filename, scope, files } = req.body ?? {};
    if (typeof title !== "string" || !title.trim() || title.length > 200)
      throw httpError(400, "title must be 1–200 characters.");
    if (filename !== "AGENTS.md") throw httpError(400, "filename must be AGENTS.md.");
    if (scope !== "global") throw httpError(400, "scope must be global.");
    validateInstructionFiles(files, filename);
    const document: Instructions = {
      id: id("instruction"), title: title.trim(), filename, scope,
      selected: true, enabled: true, revision: "", files: [], draft: clone(files),
      versions: [], targets: [], updatedAt: iso(),
    };
    req.workspace!.instructions!.push(document);
    return document;
  }));
  app.patch("/api/instructions/:id", ...mutate((req) => {
    const document = findInstructions(req);
    guardInstructionRevision(document, req.body?.expectedRevision);
    if (req.body?.title !== undefined) {
      if (typeof req.body.title !== "string" || !req.body.title.trim() || req.body.title.length > 200)
        throw httpError(400, "title must be 1–200 characters.");
      document.title = req.body.title.trim();
    }
    if (req.body?.draft !== undefined) {
      validateInstructionFiles(req.body.draft, document.filename);
      document.draft = clone(req.body.draft);
    }
    if (req.body?.enabled !== undefined) {
      if (typeof req.body.enabled !== "boolean") throw httpError(400, "enabled must be a boolean.");
      if (req.body.enabled && document.revision && (req.workspace!.instructions ?? []).some(other =>
        other.id !== document.id && other.enabled && other.revision))
        throw httpError(409, "Published global instructions already exist.");
      document.enabled = req.body.enabled;
      bump(req.workspace!);
    }
    if (req.body?.targets !== undefined) {
      document.targets = validateInstructionTargets(req.body.targets);
      bump(req.workspace!);
    }
    document.updatedAt = iso();
    return document;
  }));
  app.post("/api/instructions/:id/publish", ...mutate((req) => {
    const document = findInstructions(req);
    guardInstructionRevision(document, req.body?.expectedRevision);
    const files = clone(req.body?.files ?? document.draft ?? document.files);
    validateInstructionFiles(files, document.filename);
    if (document.enabled && (req.workspace!.instructions ?? []).some(other =>
      other.id !== document.id && other.enabled && other.revision))
      throw httpError(409, "Published global instructions already exist.");
    const rev = revision(files);
    document.files = files;
    document.revision = rev;
    document.draft = undefined;
    document.updatedAt = iso();
    document.versions.unshift({ id: id("version"), revision: rev, createdAt: iso(),
      message: typeof req.body?.message === "string" ? req.body.message : "Published", files: clone(files) });
    bump(req.workspace!);
    activity(req.workspace!, { type: "publish", title: `${document.title} published`,
      description: `Revision ${rev} is ready for devices.`, status: "pending", skillId: document.id });
    return document;
  }));
  app.post("/api/instructions/:id/rollback", ...mutate((req) => {
    const document = findInstructions(req);
    guardInstructionRevision(document, req.body?.expectedRevision);
    const version = document.versions.find(item => item.id === req.body?.versionId);
    if (!version) throw httpError(404, "Version not found.");
    validateInstructionFiles(version.files, document.filename);
    document.files = clone(version.files);
    document.revision = version.revision;
    document.draft = undefined;
    document.updatedAt = iso();
    document.versions.unshift({ id: id("version"), revision: version.revision, createdAt: iso(),
      message: `Rolled back to ${version.revision}`, files: clone(version.files) });
    bump(req.workspace!);
    return document;
  }));
  app.delete("/api/instructions/:id", ...mutate((req) => {
    const index = req.workspace!.instructions!.findIndex(item => item.id === req.params.id);
    if (index < 0) throw httpError(404, "Instructions not found.");
    req.workspace!.retiredInstructions ??= [];
    req.workspace!.retiredInstructions.push({...req.workspace!.instructions![index],selected:false,enabled:false});
    req.workspace!.instructions!.splice(index, 1);
    for (const device of req.workspace!.devices) {
      device.instructionResolutions = Object.fromEntries(Object.entries(device.instructionResolutions ?? {})
        .filter(([key]) => !key.startsWith(`${req.params.id}:`)));
      device.instructionResolutionChecks = Object.fromEntries(Object.entries(device.instructionResolutionChecks ?? {})
        .filter(([key]) => !key.startsWith(`${req.params.id}:`)));
    }
    bump(req.workspace!);
    return { ok: true };
  }));
  app.post("/api/instructions/import", ...mutate((req) => {
    const device = req.workspace!.devices.find(item => item.id === req.body?.deviceId && !item.disconnectedAt);
    if (!device) throw httpError(404, "Device not found.");
    const location = (device.instructionLocations ?? []).find(item => item.path === req.body?.path);
    if (!location?.localFiles) throw httpError(404, "Reviewed local instructions were not found.");
    if (req.body?.expectedLocalRevision !== revision(location.localFiles))
      throw httpError(409, "The device instructions changed. Review them again.");
    validateInstructionFiles(location.localFiles, "AGENTS.md");
    const importedFiles = canonicalInstructionFiles(location.localFiles);
    if (req.body?.instructionId !== undefined) {
      const document = (req.workspace!.instructions ?? []).find(item => item.id === req.body.instructionId);
      if (!document) throw httpError(404, "Instructions not found.");
      if (typeof req.body?.expectedRevision !== "string")
        throw httpError(400, "Importing into existing instructions requires the reviewed Equip revision.");
      guardInstructionRevision(document, req.body.expectedRevision);
      document.draft = importedFiles;
      document.updatedAt = iso();
      return document;
    }
    if (req.workspace!.instructions!.length)
      throw httpError(409, "Choose the global instructions document and review its current revision before importing.");
    const document: Instructions = { id: id("instruction"), title: `Instructions from ${device.name}`,
      filename: "AGENTS.md", scope: "global", selected: true, enabled: true,
      revision: "", files: [], draft: importedFiles, versions: [], targets: [], updatedAt: iso() };
    req.workspace!.instructions!.push(document);
    return document;
  }));
  app.get("/api/skills/:id", auth(true), (req: AuthedRequest, res, next) => {
    try { res.json(req.workspace!.skills.find(item => item.id === req.params.id) ?? req.workspace!.retiredSkills?.find(item => item.id === req.params.id) ?? findSkill(req)); } catch (error) { next(error); }
  });
  app.get("/api/skills/:id/export", auth(true), async (req: AuthedRequest, res, next) => {
    try {
      const skill = req.workspace!.skills.find(item => item.id === req.params.id) ?? req.workspace!.retiredSkills?.find(item => item.id === req.params.id) ?? findSkill(req);
      const version = typeof req.query.revision === "string" ? skill.versions.find(v => v.revision === req.query.revision) : undefined;
      if (req.query.revision && !version) throw httpError(404, "Revision not found.");
      const files = version?.files ?? skill.files;
      if (!files.length || (!version && !skill.revision)) throw httpError(409, "Publish this skill before exporting it.");
      // Recovery can contain damaged instructions. Export the intact folder even
      // when it is intentionally unsuitable for publication or rollback.
      if (version) validateFileEntries(files);
      const metadata = version ? {name:skill.name} : validateFiles(files, 16_384);
      const rev = version?.revision ?? skill.revision;
      const archive = await skillArchive(metadata.name, files);
      res.set({ "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${metadata.name}-${rev}.zip"`, "X-Equip-Revision": rev, "Cache-Control": "private, no-store" });
      res.send(Buffer.from(archive));
    } catch (error) { next(error); }
  });
  const resolveSource = async (source: string, name?: string) => {
    const parsed = await (await upstream()).parseUpstreamSource(source);
    if (parsed?.type === "local" || /^file:/i.test(source))
      throw httpError(
        400,
        "Server-local sources are not allowed. Connect a device that can access this source and install or import it there.",
      );
    return options.sourceResolver
      ? options.sourceResolver(source, name)
      : (await upstream()).resolveSkill(source, name, { isolate: true });
  };
  app.post(
    "/api/skills/install",
    ...mutate(async (req) => {
      const catalog = req.body?.skillId
        ? demoCatalog.find((s) => s.id === req.body.skillId)
        : undefined;
      const source = String(req.body?.source ?? catalog?.source ?? "");
      if (!source) throw httpError(400, "source or skillId is required.");
      let resolved: any;
      const sourceName = req.body?.name ?? catalog?.name;
      if (sourceName) await reviewSafety(source, String(sourceName), req.body?.auditAcknowledged);
      try {
        resolved = await resolveSource(source, sourceName);
      } catch (error: any) {
        const queued = queueSource(
          req.workspace!,
          source,
          sourceName,
          "install",
          undefined,
          error?.message ?? "Source unavailable on server.",
        );
        const request = req.workspace!.sourceRequests!.find(item => item.id === queued.body.id);
        if (request) request.auditAcknowledged = Boolean(sourceName) && req.body?.auditAcknowledged === true;
        return queued;
      }
      const metadata = validateFiles(resolved.files, 16_384);
      const safety = await reviewSafety(source, metadata.name, req.body?.auditAcknowledged);
      resolved.name = metadata.name;
      resolved.description = metadata.description;
      if (req.workspace!.skills.some((skill) => skill.name === resolved.name))
        throw httpError(409, "A skill with this name already exists.");
      const skill: Skill = {
        ...resolved,
        safety,
        id: id("skill"),
        kind: "third-party",
        selected: true,
        enabled: true,
        autoUpdate: false,
        targets: [],
        updatedAt: iso(),
        revision: resolved.revision || revision(resolved.files),
        versions: [
          {
            id: id("version"),
            revision: resolved.revision || revision(resolved.files),
            createdAt: iso(),
            message: "Installed",
            files: clone(resolved.files),
          },
        ],
      };
      req.workspace!.skills.push(skill);
      bump(req.workspace!);
      activity(req.workspace!, {
        type: "install",
        title: `${skill.title} installed`,
        description: `Revision ${skill.revision} is ready for connected devices.`,
        status: "pending",
        skillId: skill.id,
      });
      return skill;
    }),
  );
  app.post(
    "/api/skills",
    ...mutate((req) => {
      const {
        title,
        name,
        description,
        files,
        category = "Custom",
      } = req.body ?? {};
      validateFileEntries(files);
      const skill: Skill = {
        id: id("skill"),
        name,
        title,
        description,
        author: req.workspace!.name,
        source: "custom",
        kind: "custom",
        category,
        icon: "wand-sparkles",
        color: "#7259ff",
        selected: true,
        enabled: true,
        autoUpdate: false,
        revision: "",
        versions: [],
        files: [],
        draft: clone(files),
        requirements: [],
        targets: [],
        updatedAt: iso(),
      };
      req.workspace!.skills.push(skill);
      return skill;
    }),
  );
  app.patch(
    "/api/skills/:id",
    ...mutate((req) => {
      const skill = findSkill(req);
      if (req.body?.targets !== undefined) validateInstructionTargets(req.body.targets);
      for (const key of ["enabled", "autoUpdate"] as const) if (req.body?.[key] !== undefined && typeof req.body[key] !== "boolean") throw httpError(400, `${key} must be a boolean.`);
      for (const key of [
        "enabled",
        "autoUpdate",
        "targets",
        "title",
        "description",
        "draft",
      ] as const)
        if (req.body?.[key] !== undefined)
          (skill as any)[key] = clone(req.body[key]);
      if (req.body?.draft) validateFileEntries(req.body.draft);
      skill.updatedAt = iso();
      if (req.body?.enabled !== undefined || req.body?.targets !== undefined)
        bump(req.workspace!);
      return skill;
    }),
  );
  app.post(
    "/api/skills/:id/source",
    ...mutate(async (req) => {
      const skill = findSkill(req);
      const source = typeof req.body?.source === "string" ? req.body.source.trim() : "";
      if (!source) throw httpError(400, "source is required.");
      let resolved: any;
      try {
        resolved = await resolveSource(source, skill.name);
      } catch (error: any) {
        throw httpError(error?.status ?? 400, error?.message ?? "Source unavailable.");
      }
      const metadata = validateFiles(resolved.files, 16_384);
      if (resolved.name !== skill.name || metadata.name !== skill.name)
        throw httpError(400, `Source must resolve to skill ${skill.name}.`);
      const same = canonicalFiles(resolved.files) === canonicalFiles(skill.files);
      const wasCustom = skill.kind === "custom";
      const resolvedSource = resolved.source || source;
      const refreshDesired =
        skill.kind !== "third-party" ||
        skill.source !== resolvedSource ||
        skill.author !== resolved.author ||
        skill.category !== "Community" ||
        skill.icon !== "package" ||
        (wasCustom && skill.autoUpdate);
      skill.kind = "third-party";
      skill.source = resolvedSource;
      skill.author = resolved.author;
      skill.category = "Community";
      skill.icon = "package";
      if (wasCustom) skill.autoUpdate = false;
      skill.upstreamRevision = same
        ? undefined
        : (resolved.revision && resolved.revision !== skill.revision
            ? resolved.revision
            : revision(resolved.files));
      skill.proposal = same ? undefined : {revision:skill.upstreamRevision!,files:clone(resolved.files),checkedAt:iso()};
      skill.upstreamCheckedAt = iso();
      skill.updatedAt = iso();
      if (refreshDesired) bump(req.workspace!);
      return skill;
    }),
  );
  app.post(
    "/api/skills/:id/publish",
    ...mutate((req) => {
      const skill = findSkill(req);
      const files = clone(req.body?.files ?? skill.draft ?? skill.files);
      const metadata = validateFiles(files);
      if (
        req.workspace!.skills.some(
          (other) => other.id !== skill.id && other.name === metadata.name,
        )
      )
        throw httpError(409, "A skill with this name already exists.");
      const rev = revision(files);
      skill.name = metadata.name;
      skill.description = metadata.description;
      skill.files = files;
      skill.revision = rev;
      skill.proposal = undefined;
      skill.upstreamRevision = undefined;
      skill.draft = undefined;
      skill.updatedAt = iso();
      skill.versions.unshift({
        id: id("version"),
        revision: rev,
        createdAt: iso(),
        message: String(req.body?.message ?? "Published"),
        files: clone(files),
      });
      bump(req.workspace!);
      activity(req.workspace!, {
        type: "publish",
        title: `${skill.title} published`,
        description: `Revision ${rev} is ready for devices.`,
        status: "pending",
        skillId: skill.id,
      });
      return skill;
    }),
  );
  app.post(
    "/api/skills/:id/check",
    ...mutate(async (req) => {
      const skill = findSkill(req);
      if (skill.kind !== "third-party")
        throw httpError(400, "Custom skills have no upstream source.");
      const resolved: any = await resolveSource(skill.source, skill.name);
      validateFiles(resolved.files, 16_384);
      const same = canonicalFiles(resolved.files) === canonicalFiles(skill.files);
      const nextRevision = resolved.revision && resolved.revision !== skill.revision ? resolved.revision : revision(resolved.files);
      skill.upstreamCheckedAt = iso();
      skill.upstreamRevision =
        same ? undefined : nextRevision;
      skill.proposal = same ? undefined : { revision:nextRevision, files:clone(resolved.files), checkedAt:iso() };
      return skill;
    }),
  );
  app.post(
    "/api/skills/:id/update",
    ...mutate(async (req) => {
      const skill = findSkill(req);
      if (skill.kind !== "third-party")
        throw httpError(400, "Custom skills have no upstream source.");
      if (req.body?.expectedRevision !== undefined && req.body.expectedRevision !== skill.revision) throw httpError(409, "The deployed revision changed. Review the update again.");
      if (req.body?.expectedUpstreamRevision !== undefined && (!skill.proposal || req.body.expectedUpstreamRevision !== skill.proposal.revision)) throw httpError(409, "The proposed revision changed. Review the update again.");
      await reviewSafety(skill.source, skill.name, req.body?.auditAcknowledged);
      let resolved: any;
      try { resolved = req.body?.expectedUpstreamRevision ? { ...skill, files:clone(skill.proposal!.files), revision:skill.proposal!.revision } : await resolveSource(skill.source, skill.name); }
      catch (error: any) {
        const queued = queueSource(req.workspace!, skill.source, skill.name, "install", skill.id, error?.message ?? "Source unavailable on server.");
        const request = req.workspace!.sourceRequests!.find(item => item.id === queued.body.id);
        if (request) { request.auditAcknowledged = req.body?.auditAcknowledged === true; request.automatic = false; }
        return queued;
      }
      const metadata = validateFiles(resolved.files, 16_384);
      if (canonicalFiles(resolved.files) === canonicalFiles(skill.files)) {
        skill.upstreamCheckedAt = iso();
        skill.upstreamRevision = undefined;
      skill.proposal = undefined;
        return skill;
      }
      const safety = await reviewSafety(skill.source, metadata.name, req.body?.auditAcknowledged);
      if (
        req.workspace!.skills.some(
          (other) => other.id !== skill.id && other.name === metadata.name,
        )
      )
        throw httpError(409, "A skill with this name already exists.");
      skill.safety = safety;
      skill.name = metadata.name;
      skill.description = metadata.description;
      skill.files = clone(resolved.files);
      skill.revision = resolved.revision && resolved.revision !== skill.revision ? resolved.revision : revision(resolved.files);
      skill.upstreamRevision = undefined;
      skill.proposal = undefined;
      skill.upstreamCheckedAt = iso();
      skill.updatedAt = iso();
      skill.versions.unshift({
        id: id("version"),
        revision: skill.revision,
        createdAt: iso(),
        message: "Updated from upstream",
        files: clone(skill.files),
      });
      bump(req.workspace!);
      return skill;
    }),
  );
  app.post(
    "/api/skills/:id/rollback",
    ...mutate((req) => {
      const skill = req.workspace!.skills.find(item=>item.id===req.params.id) ?? req.workspace!.retiredSkills?.find(item=>item.id===req.params.id) ?? findSkill(req);
      const version = skill.versions.find((v) => v.id === req.body?.versionId);
      if (!version) throw httpError(404, "Version not found.");
      const metadata = validateFiles(
        version.files,
        skill.kind === "third-party" ? 16_384 : 1024,
      );
      if (
        req.workspace!.skills.some(
          (other) => other.id !== skill.id && other.name === metadata.name,
        )
      )
        throw httpError(409, "A skill with this name already exists.");
      if (!req.workspace!.skills.some(item=>item.id===skill.id)) {
        req.workspace!.retiredSkills = req.workspace!.retiredSkills?.filter(item=>item.id!==skill.id);
        skill.selected=true;skill.enabled=true;skill.autoUpdate=false;
        req.workspace!.skills.push(skill);
      }
      skill.name = metadata.name;
      skill.description = metadata.description;
      skill.files = clone(version.files);
      skill.revision = version.revision;
      skill.upstreamRevision = undefined;
      skill.proposal = undefined;
      skill.upstreamCheckedAt = undefined;
      skill.updatedAt = iso();
      skill.versions.unshift({
        id: id("version"),
        revision: version.revision,
        createdAt: iso(),
        message: `Rolled back to ${version.revision}`,
        files: clone(version.files),
      });
      bump(req.workspace!);
      return skill;
    }),
  );
  app.delete(
    "/api/skills/:id",
    ...mutate((req) => {
      const index = req.workspace!.skills.findIndex(
        (s) => s.id === req.params.id,
      );
      if (index < 0) throw httpError(404, "Skill not found.");
      req.workspace!.retiredSkills ??= [];
      req.workspace!.retiredSkills.push({...req.workspace!.skills[index], selected:false, enabled:false});
      req.workspace!.skills.splice(index, 1);
      bump(req.workspace!);
      return { ok: true };
    }),
  );
  app.post(
    "/api/skills/import",
    ...mutate(async (req) => {
      const source = String(req.body?.source ?? "");
      if (!source) throw httpError(400, "source is required.");
      let resolved: any;
      try {
        resolved = await resolveSource(source, req.body?.name);
      } catch (error: any) {
        return queueSource(
          req.workspace!,
          source,
          req.body?.name,
          "import",
          undefined,
          error?.message ?? "Source unavailable on server.",
        );
      }
      const metadata = validateFiles(resolved.files, 16_384);
      const skill: Skill = {
        ...resolved,
        name: metadata.name,
        description: metadata.description,
        id: id("skill"),
        kind: "custom",
        source,
        selected: true,
        enabled: true,
        autoUpdate: false,
        revision: "",
        files: [],
        draft: clone(resolved.files),
        versions: [],
        targets: [],
        updatedAt: iso(),
      };
      req.workspace!.skills.push(skill);
      return skill;
    }),
  );
  app.post(
    "/api/skills/assist",
    auth(false),
    (req: AuthedRequest, res, next) => {
      try {
        res.json({ files: buildSkillDraft(req.body ?? {}) });
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/devices/:id/instructions/resolve",
    ...mutate((req) => {
      const device = req.workspace!.devices.find(item => item.id === req.params.id && !item.disconnectedAt);
      if (!device) throw httpError(404, "Device not found.");
      const { instructionId, agent, profile, project, action, expectedRevision, expectedLocalRevision } = req.body ?? {};
      if (!["replace", "preserve", "import", "publish", "merge"].includes(action))
        throw httpError(400, "Invalid instruction resolution.");
      const document = (req.workspace!.instructions ?? []).find(item => item.id === instructionId);
      const receipt = device.receipts.find(item => item.kind === "instructions" && item.skillId === instructionId &&
        item.agent === agent && item.profile === profile && item.project === project);
      if (receipt?.status !== "conflicted")
        throw httpError(409, "A current conflicted instruction file is required.");
      if (document && expectedRevision !== undefined && expectedRevision !== document.revision)
        throw httpError(409, "The Equip revision changed. Review the instructions again.");
      if (receipt.localFiles !== undefined && typeof expectedLocalRevision !== "string")
        throw httpError(400, "Resolving a conflict requires the reviewed local revision.");
      if (expectedLocalRevision !== undefined && (!receipt.localFiles || expectedLocalRevision !== revision(receipt.localFiles)))
        throw httpError(409, "The device instructions changed. Review them again.");
      const key = instructionKey(instructionId, { agent, profile, project });
      if (action === "publish" || action === "merge") {
        if (!document) throw httpError(404, "Instructions not found.");
        if (typeof expectedRevision !== "string" || typeof expectedLocalRevision !== "string")
          throw httpError(400, "Publishing a conflict requires the reviewed Equip and local revisions.");
        if (receipt?.status !== "conflicted" || !receipt.localFiles?.length)
          throw httpError(409, "A current conflicted instruction file is required.");
        const candidate = action === "merge" ? req.body.mergedFiles : receipt.localFiles;
        validateInstructionFiles(candidate);
        const files = canonicalInstructionFiles(candidate);
        if (action === "merge" && files.some(file => hasMergeMarkers(file.content))) throw httpError(400, "Resolve merge markers before publishing.");
        const rev = revision(files);
        if (!sameFiles(document.files, files)) {
          document.files = files;
          document.revision = rev;
          document.updatedAt = iso();
          document.versions.unshift({ id: id("version"), revision: rev, createdAt: iso(),
            message: `${action === "merge" ? "Merged local changes" : "Published local conflict"} from ${device.name}`, files: clone(files) });
          bump(req.workspace!);
          activity(req.workspace!, { type: "publish", title: `${document.title} published from ${device.name}`,
            description: `Revision ${rev} is ready for connected devices.`, status: "pending",
            deviceId: device.id, skillId: document.id });
        }
        if (action === "merge") {
          device.instructionResolutions ??= {}; device.instructionResolutionChecks ??= {};
          device.instructionResolutions[key] = "replace";
          device.instructionResolutionChecks[key] = expectedLocalRevision;
          bump(req.workspace!);
        } else {
          delete device.instructionResolutions?.[key];
          delete device.instructionResolutionChecks?.[key];
        }
        return device;
      }
      if (action === "import") {
        if (!receipt.localFiles?.length)
          throw httpError(400, "There are no local instructions to import.");
        validateInstructionFiles(receipt.localFiles, "AGENTS.md");
        const importedFiles = canonicalInstructionFiles(receipt.localFiles);
        const importTarget = document ?? req.workspace!.instructions?.[0];
        if (importTarget?.draft && !sameFiles(importTarget.draft, importedFiles))
          throw httpError(409, "Publish or review the saved instruction draft before importing another local version.");
      }
      device.instructionResolutions ??= {};
      device.instructionResolutionChecks ??= {};
      device.instructionResolutions[key] = action;
      device.instructionResolutionChecks[key] = expectedLocalRevision ?? (receipt?.localFiles ? revision(receipt.localFiles) : receipt?.revision ?? "");
      bump(req.workspace!);
      return device;
    }),
  );
  app.post(
    "/api/devices/:id/disconnect",
    ...mutate((req) => {
      const device = req.workspace!.devices.find((d) => d.id === req.params.id);
      if (!device) throw httpError(404, "Device not found.");
      const mode = req.body?.mode;
      if (mode !== "retain" && mode !== "remove")
        throw httpError(400, "mode must be retain or remove.");
      device.disconnect = mode;
      delete device.disconnectedAt;
      bump(req.workspace!);
      return device;
    }),
  );
  app.patch(
    "/api/devices/:id/local-sync",
    ...mutate((req) => {
      const device = req.workspace!.devices.find(d => d.id === req.params.id && !d.disconnectedAt);
      if (!device) throw httpError(404, "Device not found.");
      if (typeof req.body?.enabled !== "boolean") throw httpError(400, "enabled must be a boolean.");
      device.localSync = { ...device.localSync, enabled: req.body.enabled, error: undefined };
      bump(req.workspace!);
      return device.localSync;
    }),
  );
  app.post(
    "/api/library/unlink",
    ...mutate((req) => {
      return { ok: true, unlinked: false };
    }),
  );
  app.post(
    "/api/devices/:id/resolve",
    ...mutate((req) => {
      const device = req.workspace!.devices.find((d) => d.id === req.params.id);
      if (!device) throw httpError(404, "Device not found.");
      const {
        skillId,
        agent,
        profile,
        project,
        action,
        expectedRevision,
        expectedLocalRevision,
      } = req.body ?? {};
      if (!["preserve", "replace", "import", "publish", "merge"].includes(action))
        throw httpError(400, "Invalid resolution.");
      const original = req.workspace!.skills.find((skill) => skill.id === skillId);
      const receipt = device.receipts.find(
        (item) =>
          item.skillId === skillId &&
          item.agent === agent &&
          item.profile === profile &&
          item.project === project,
      );
      if (
        expectedRevision !== undefined &&
        (!original || expectedRevision !== original.revision)
      )
        throw httpError(409, "The Equip revision changed. Review the conflict again.");
      if (expectedLocalRevision !== undefined && (
        !receipt?.localFiles || expectedLocalRevision !== revision(receipt.localFiles)
      ))
        throw httpError(409, "The device conflict changed. Review the conflict again.");
      if (action === "publish" || action === "merge") {
        if (typeof expectedRevision !== "string" || typeof expectedLocalRevision !== "string")
          throw httpError(400, "Publishing a conflict requires the reviewed Equip and local revisions.");
        if (!original) throw httpError(404, "Skill not found.");
        if (receipt?.status !== "conflicted" || !receipt.localFiles?.length)
          throw httpError(409, "A current conflicted local skill is required.");
        const files = clone(action === "merge" ? req.body.mergedFiles : receipt.localFiles);
        const metadata = validateFiles(files, 16_384);
        if (action === "merge" && files.some((file:SkillFile) => file.encoding !== "base64" && hasMergeMarkers(file.content))) throw httpError(400, "Resolve merge markers before publishing.");
        if (metadata.name !== original.name)
          throw httpError(409, "A renamed local skill must be imported as a separate draft.");
        const rev = revision(files);
        const custom = original.kind === "custom";
        const changed =
          canonicalFiles(original.files) !== canonicalFiles(files) ||
          (custom && original.author !== req.workspace!.name) ||
          original.autoUpdate ||
          original.description !== metadata.description ||
          original.upstreamRevision !== undefined ||
          original.upstreamCheckedAt !== undefined;
        if (changed) {
          original.description = metadata.description;
          original.files = files;
          original.revision = rev;
          if (custom) original.author = req.workspace!.name;
          original.autoUpdate = false;
          original.updatedAt = iso();
          original.versions.unshift({
            id: id("version"),
            revision: rev,
            createdAt: iso(),
            message: `${action === "merge" ? "Merged local changes" : "Published local conflict"} from ${device.name}`,
            files: clone(files),
          });
          original.upstreamRevision = undefined;
          original.proposal = undefined;
          original.upstreamCheckedAt = undefined;
          bump(req.workspace!);
          activity(req.workspace!, {
            type: "publish",
            title: `${original.title} published from ${device.name}`,
            description: `Revision ${rev} is ready for connected devices.`,
            status: "pending",
            deviceId: device.id,
            skillId: original.id,
          });
        }
        device.resolutions ??= {};
        if (action === "merge") {device.resolutions[resolutionKey(skillId, agent, profile, project)] = "replace"; bump(req.workspace!);}
        else delete device.resolutions[resolutionKey(skillId, agent, profile, project)];
        delete device.resolutions[`${skillId}:${agent}`];
        return device;
      }
      if (action === "import") {
        if (receipt?.localFiles && receipt.localFiles.length === 0)
          throw httpError(400, "There are no local files to import.");
      }
      device.resolutions ??= {};
      device.resolutions[resolutionKey(skillId, agent, profile, project)] =
        action;
      bump(req.workspace!);
      return device;
    }),
  );
  app.patch("/api/devices/:id/agents", ...mutate(req => {
    const device = req.workspace!.devices.find(item => item.id === req.params.id && !item.disconnectedAt);
    if (!device) throw httpError(404, "Computer not found.");
    const targets = validateInstructionTargets((req.body?.excludedAgents ?? []).map((item: any) => ({...item, deviceId:device.id, enabled:false})));
    if (targets.some(target => !device.agents.some(agent => agent.id === target.agent && agent.profile === target.profile && agent.project === target.project))) throw httpError(400, "The excluded configuration was not detected on this computer.");
    device.excludedAgents = targets.map(({agent,profile,project}) => ({agent,profile,project}));
    bump(req.workspace!);
    return device;
  }));
  app.post("/api/changes/reviewed", ...mutate(req => {
    const key = req.body?.key;
    if (typeof key !== "string" || key.length > 300 || !key.startsWith("recovery:")) throw httpError(400, "Invalid change identifier.");
    const exists = [...req.workspace!.skills, ...(req.workspace!.instructions ?? []), ...(req.workspace!.retiredSkills ?? []), ...(req.workspace!.retiredInstructions ?? [])].some(item => item.versions.some(version => key === `recovery:${item.id}:${version.id}` && version.message.startsWith("Recovered from ")));
    if (!exists) throw httpError(404, "Recovered version not found.");
    req.workspace!.reviewedChanges = [...new Set([...(req.workspace!.reviewedChanges ?? []), key])].slice(-10000);
    return {ok:true};
  }));
  app.get("/api/compatibility", async (_req, res, next) => {
    try {
      res.json(await (await upstream()).getCompatibility());
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/device/authorize", async (req, res, next) => {
    try {
      const { name, os, arch } = req.body ?? {};
      if (
        typeof name !== "string" ||
        !name.trim() ||
        name.length > 120 ||
        typeof os !== "string" ||
        !os ||
        os.length > 40 ||
        typeof arch !== "string" ||
        !arch ||
        arch.length > 40
      )
        throw httpError(400, "name, os, and arch are required.");
      const now = Date.now();
      if (!(await limitAuth(req, res, "device-authorize", 30))) return;
      const deviceCode = crypto.randomBytes(32).toString("base64url");
      const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      const part = () =>
        Array.from(crypto.randomBytes(4), (b) => chars[b % chars.length]).join(
          "",
        );
      const userCode = `${part()}-${part()}`;
      const expiresIn = 600;
      await db.run(
        "DELETE FROM device_authorizations WHERE expires_at<=?",
        now,
      );
      await db.run(
        "INSERT INTO device_authorizations VALUES(?,?,?,?,?,?,?,?)",
        digest(deviceCode),
        userCode,
        null,
        name,
        os,
        arch,
        "pending",
        now + expiresIn * 1000,
      );
      res.status(201).json({
        deviceCode,
        userCode,
        verificationUri: `${publicOrigin(req)}/connect?code=${userCode}`,
        expiresIn,
        interval: 2,
      });
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/device/authorization", async (req, res) => {
    if (!(await limitAuth(req, res, "device-code", 60))) return;
    const row = await db.get<any>(
      "SELECT name,os,user_code,expires_at,status FROM device_authorizations WHERE user_code=?",
      String(req.query.code ?? "").toUpperCase(),
    );
    if (!row || row.expires_at <= Date.now())
      return res.status(404).json({ error: "authorization_not_found" });
    res.json({
      name: row.name,
      os: row.os,
      userCode: row.user_code,
      expiresAt: new Date(Number(row.expires_at)).toISOString(),
    });
  });
  app.post(
    "/api/device/approve",
    auth(false),
    async (req: AuthedRequest, res, next) => {
      try {
        writable(req);
        if (!(await limitAuth(req, res, "device-approve", 30))) return;
        const code = String(req.body?.userCode ?? "").toUpperCase();
        const row = await db.get<any>(
          "SELECT * FROM device_authorizations WHERE user_code=?",
          code,
        );
        if (!row) throw httpError(404, "Authorization not found.");
        if (row.expires_at <= Date.now())
          throw httpError(410, "Authorization expired.");
        if (row.status !== "pending")
          throw httpError(409, "Authorization was already used.");
        const changed = await db.run(
          "UPDATE device_authorizations SET account_id=?,status='approved' WHERE user_code=? AND status='pending'",
          req.accountId,
          code,
        );
        if (!changed.changes)
          throw httpError(409, "Authorization was already used.");
        res.json({ ok: true });
      } catch (error) {
        next(error);
      }
    },
  );
  app.post("/api/device/token", async (req, res) => {
    if (!(await limitAuth(req, res, "device-token", 360))) return;
    const codeHash = digest(String(req.body?.deviceCode ?? ""));
    const row = await db.get<any>(
      "SELECT * FROM device_authorizations WHERE device_code_hash=?",
      codeHash,
    );
    if (!row) return res.status(403).json({ error: "invalid_device_code" });
    if (row.expires_at <= Date.now())
      return res.status(410).json({ error: "expired_token" });
    if (row.status === "pending")
      return res.status(428).json({ error: "authorization_pending" });
    if (row.status !== "approved" || !row.account_id)
      return res.status(403).json({ error: "access_denied" });
    const token = crypto.randomBytes(32).toString("base64url");
    const deviceId = id("device");
    try {
      await runAccountLocked(row.account_id, async () => {
        await db.transaction(async (transaction) => {
          const changed = await transaction.run(
            "UPDATE device_authorizations SET status='consumed' WHERE device_code_hash=? AND status='approved'",
            codeHash,
          );
          if (!changed.changes)
            throw httpError(403, "Authorization was already used.");
          await transaction.run(
            "INSERT INTO device_tokens VALUES(?,?,?,?,?)",
            digest(token),
            row.account_id,
            deviceId,
            null,
            Date.now(),
          );
          const account = await transaction.get<any>(
            "SELECT workspace FROM accounts WHERE id=?",
            row.account_id,
          );
          const workspace: Workspace = parseWorkspace(await readWorkspace(db, row.account_id, account.workspace));
          workspace.devices.push({
            id: deviceId,
            name: row.name,
            os: row.os,
            arch: row.arch,
            online: true,
            lastSeen: iso(),
            agents: [],
            receipts: [],
          });
          bump(workspace);
          await saveWorkspace(transaction, row.account_id, workspace);
        });
      });
      res.json({ token, deviceId });
    } catch (error: any) {
      res.status(error.status ?? 500).json({ error: error.status ? error.message : "The server could not complete the request. Try again shortly." });
    }
  });

  const deviceAuth = async (
    req: AuthedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    const match = req.get("authorization")?.match(/^Bearer (.+)$/);
    const row = match
      ? await db.get<any>(
          "SELECT * FROM device_tokens WHERE token_hash=? AND revoked_at IS NULL",
          digest(match[1]),
        )
      : undefined;
    if (!row) return res.status(401).json({ error: "invalid_token" });
    const account = await db.get<any>(
      "SELECT workspace FROM accounts WHERE id=?",
      row.account_id,
    );
    if (!account) return res.status(401).json({ error: "invalid_token" });
    req.accountId = row.account_id;
    req.deviceId = row.device_id;
    req.workspace = parseWorkspace(await readWorkspace(db, req.accountId!, account.workspace, true));
    next();
  };
  const deviceIdentityAuth = async (
    req: AuthedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    const match = req.get("authorization")?.match(/^Bearer (.+)$/);
    const row = match
      ? await db.get<any>(
          "SELECT account_id,device_id FROM device_tokens WHERE token_hash=? AND revoked_at IS NULL",
          digest(match[1]),
        )
      : undefined;
    if (!row) return res.status(401).json({ error: "invalid_token" });
    req.accountId = row.account_id;
    req.deviceId = row.device_id;
    next();
  };
  app.post(
    "/api/device/instructions/local",
    deviceAuth,
    workspaceHandler(async (req: AuthedRequest, res, next) => {
      try {
        const device = req.workspace!.devices.find(item => item.id === req.deviceId)!;
        if (!device.localSync?.enabled) throw httpError(403, "Local publishing is disabled for this device.");
        const document = (req.workspace!.instructions ?? []).find(item => item.id === req.body?.instructionId);
        if (!document || !document.revision) throw httpError(404, "Published instructions not found.");
        if (req.body?.baseRevision !== document.revision)
          throw httpError(409, "The Equip revision changed. Local files were preserved for review.");
        validateInstructionFiles(req.body?.files, document.filename);
        const files = clone(req.body.files) as SkillFile[];
        if (!sameFiles(document.files, files)) {
          const rev = revision(files);
          document.files = files;
          document.revision = rev;
          document.updatedAt = iso();
          document.versions.unshift({ id: id("version"), revision: rev, createdAt: iso(),
            message: `Published local edit from ${device.name}`, files: clone(files) });
          bump(req.workspace!);
          activity(req.workspace!, { type: "publish", title: `${document.title} published from ${device.name}`,
            description: `Revision ${rev} is ready for connected devices.`, status: "pending",
            deviceId: device.id, skillId: document.id });
        }
        await saveWorkspace(db, req.accountId!, req.workspace!);
        res.json(document);
      } catch (error) { next(error); }
    }),
  );
  app.post(
    "/api/device/recovery",
    deviceIdentityAuth,
    async (req: AuthedRequest, res, next) => {
      try {
        if (typeof req.body?.skillId !== "string" || !req.body.skillId)
          throw httpError(400, "skillId is required.");
        if (req.body.kind !== undefined && req.body.kind !== "instructions")
          throw httpError(400, "kind must be instructions when provided.");
        if (req.body.path !== undefined &&
            (typeof req.body.path !== "string" || !req.body.path ||
             req.body.path.length > 2048 || req.body.path.includes("\0")))
          throw httpError(400, "path must be a non-empty local path of at most 2048 characters.");

        const result = await runAccountLocked(req.accountId!, async () => {
          const row = await db.get<any>("SELECT workspace FROM accounts WHERE id=?", req.accountId!);
          if (!row) throw httpError(401, "invalid_token");
          const workspace = parseWorkspace(await readWorkspace(db, req.accountId!, row.workspace));
          const device = workspace.devices.find(item => item.id === req.deviceId);
          if (!device) throw httpError(401, "invalid_token");
          const isInstructions = req.body.kind === "instructions";
          const item = isInstructions
            ? [...(workspace.instructions ?? []), ...(workspace.retiredInstructions ?? [])].find(document => document.id === req.body.skillId)
            : [...workspace.skills, ...(workspace.retiredSkills ?? [])].find(skill => skill.id === req.body.skillId);
          if (!item)
            throw httpError(404, isInstructions ? "Instructions not found." : "Skill not found.");

          let files = clone(req.body.files) as SkillFile[];
          if (isInstructions) {
            validateInstructionFiles(files);
            files = files.map(file => ({ ...file, path: (item as Instructions).filename }));
            validateInstructionFiles(files, (item as Instructions).filename);
          } else {
            validateFileEntries(files);
            if (!files.length) throw httpError(400, "Recovery files cannot be empty.");
          }
          const rev = revision(files);
          const existing = item.versions.find(version =>
            version.revision === rev && sameFiles(version.files, files));
          if (!existing) {
            const source = req.body.path ? ` at ${req.body.path}` : "";
            item.versions.push({
              id: id("version"),
              revision: rev,
              createdAt: iso(),
              message: `Recovered from ${device.name}${source}`,
              files: clone(files),
            });
            await saveWorkspace(db, req.accountId!, workspace);
          }
          return { id: item.id, revision: rev, archived: true };
        });
        res.json(result);
      } catch (error) { next(error); }
    },
  );
  app.post(
    "/api/device/local",
    deviceAuth,
    workspaceHandler(async (req: AuthedRequest, res, next) => {
      try {
        const workspace = req.workspace!;
        const device = workspace.devices.find(d => d.id === req.deviceId)!;
        if (!device.localSync?.enabled && req.body?.explicit !== true)
          throw httpError(403, "Local importing is disabled for this computer.");
        const files = clone(req.body?.files);
        const metadata = validateFiles(files, 16_384);
        if (req.body?.name !== metadata.name) throw httpError(400, "Local folder name must match SKILL.md.");
        if (typeof req.body?.sourcePath !== "string" || !req.body.sourcePath || req.body.sourcePath.length > 2048)
          throw httpError(400, "A local source path is required.");
        let skill = workspace.skills.find(s => s.name === metadata.name);
        if (skill && !sameFiles(skill.files, files)) {
          if (skill.kind !== "custom")
            throw httpError(409, "This skill has a separate source. Import it under another name or resolve its local conflict.");
          if (!req.body.baseRevision || req.body.baseRevision !== skill.revision)
            throw httpError(409, "The dashboard revision changed. Local files were preserved; review the conflict before publishing.");
        }
        if (!skill) {
          if (req.body.baseRevision) throw httpError(409, "This skill was removed in Equip. Local files were preserved.");
          skill = {
            id: id("skill"), name: metadata.name, title: metadata.name,
            description: metadata.description, author: workspace.name,
            source: "local", kind: "custom", category: "Custom", icon: "wand-sparkles", color: "#7259ff",
            selected: true, enabled: true, autoUpdate: false, revision: "", versions: [], files: [],
            requirements: [], targets: [], updatedAt: iso(),
            localOrigin: { deviceId: device.id, path: req.body.sourcePath },
          };
          workspace.skills.push(skill);
        }
        const changed = !sameFiles(skill.files, files);
        if (changed) {
          const rev = revision(files);
          skill.files = files;
          skill.description = metadata.description;
          skill.revision = rev;
          skill.updatedAt = iso();
          skill.draft = undefined;
          skill.versions.unshift({ id: id("version"), revision: rev, createdAt: iso(), message: `Published from ${device.name}`, files: clone(files) });
          bump(workspace);
          activity(workspace, { type: "publish", title: `${skill.title} received from ${device.name}`, description: `Revision ${rev} is ready for connected destinations.`, status: "pending", deviceId: device.id, skillId: skill.id });
        }
        device.localSync = { enabled: device.localSync?.enabled ?? false, ...device.localSync, lastImport: iso(), error: undefined };
        await saveWorkspace(db, req.accountId!, workspace);
        res.json({ id: skill.id, revision: skill.revision, generation: workspace.generation, changed });
      } catch (error) { next(error); }
    }),
  );
  app.post(
    "/api/device/library",
    deviceAuth,
    workspaceHandler(async (req: AuthedRequest, res, next) => {
      try {
        if (req.body?.expectedRevision !== undefined)
          throw httpError(409, "Libraries are imported once. Equip manages their revisions; automatic source publishing is disabled.");
        const snapshot = validateLibrarySnapshot(req.body);
        const workspace = req.workspace!;
        // Validate every collision before adding anything. An import never replaces
        // a dashboard revision or removes skills absent from the source folder.
        for (const incoming of snapshot.skills) {
          const existing = workspace.skills.find(skill => skill.name === incoming.name);
          if (existing && !sameFiles(existing.files, incoming.files))
            throw httpError(409, `Skill ${incoming.name} already exists with different instructions. Rename it before importing.`);
        }
        let added = 0;
        for (const incoming of snapshot.skills) {
          if (workspace.skills.some(skill => skill.name === incoming.name)) continue;
          const metadata = validateFiles(incoming.files, 16_384);
          const rev = revision(incoming.files);
          workspace.skills.push({
            id: id("skill"), name: incoming.name, title: incoming.title,
            description: metadata.description, author: snapshot.name,
            source: incoming.source, kind: incoming.kind,
            category: incoming.kind === "custom" ? "Custom" : "Community",
            icon: incoming.kind === "custom" ? "wand-sparkles" : "package", color: "#7259ff",
            selected: true, enabled: true, autoUpdate: false, revision: rev,
            versions: [{ id: id("version"), revision: rev, createdAt: iso(), message: `Imported from ${snapshot.name}`, files: clone(incoming.files) }],
            files: clone(incoming.files), requirements: [], targets: [], updatedAt: iso(),
          });
          added++;
        }
        if (added) {
          bump(workspace);
          activity(workspace, { type: "library", title: `Imported ${added} skills from ${snapshot.name}`, description: "Equip manages their selected revisions and installations.", status: "pending", deviceId: req.deviceId });
          await saveWorkspace(db, req.accountId!, workspace);
        }
        res.json({ accepted: true, revision: snapshot.revision, skillCount: snapshot.skills.length, added, generation: workspace.generation });
      } catch (error) {
        next(error);
      }
    }),
  );
  app.post(
    "/api/device/library/unlink",
    deviceAuth,
    workspaceHandler(async (req: AuthedRequest, res, next) => {
      try {
        res.json({ ok: true, unlinked: false });
      } catch (error) {
        next(error);
      }
    }),
  );
  app.post(
    "/api/device/source",
    deviceAuth,
    workspaceHandler(async (req: AuthedRequest, res, next) => {
      try {
        const requestId = String(req.body?.requestId ?? "");
        const requests = req.workspace!.sourceRequests ?? [];
        const index = requests.findIndex((request) => request.id === requestId);
        if (index < 0) return res.json({ ok: true, accepted: false });
        const sourceRequest = requests[index];
        const device = req.workspace!.devices.find(
          (item) => item.id === req.deviceId,
        )!;
        if (req.body?.error) {
          const description = `${device.name}: ${String(req.body.error)}`;
          if (
            !req.workspace!.activity.some(
              (item) =>
                item.type === "source-failed" &&
                item.deviceId === device.id &&
                item.description === description,
            )
          )
            activity(req.workspace!, {
              type: "source-failed",
              title: "Source unavailable on device",
              description,
              status: "failed",
              deviceId: device.id,
              skillId: sourceRequest.skillId,
            });
          await saveWorkspace(db, req.accountId!, req.workspace!);
          return res.json({ ok: true, accepted: false });
        }
        const resolved: any = req.body?.resolved;
        if (
          !resolved ||
          resolved.source !== sourceRequest.source ||
          (sourceRequest.name && resolved.name !== sourceRequest.name) ||
          typeof resolved.revision !== "string" ||
          !resolved.revision
        )
          throw httpError(400, "Resolved source does not match the request.");
        const sourceMetadata = validateFiles(resolved.files, 16_384);
        if (sourceMetadata.name !== resolved.name)
          throw httpError(400, "Resolved source metadata does not match its name.");
        if (sourceRequest.kind !== "import") {
          const safety = await resolveSafety(sourceRequest.source, resolved.name);
          resolved.safety = safety;
          if (((safety.status === "warn" || safety.status === "fail") && !sourceRequest.auditAcknowledged) || (sourceRequest.automatic && safety.status === "unavailable")) {
            sourceRequest.reason = "Security reports require manual review. The selected revision is unchanged.";
            await saveWorkspace(db, req.accountId!, req.workspace!);
            throw httpError(409, sourceRequest.reason);
          }
        }
        if (sourceRequest.skillId) {
          const skill = req.workspace!.skills.find(
            (item) => item.id === sourceRequest.skillId,
          );
          if (!skill) throw httpError(404, "Requested skill no longer exists.");
          skill.upstreamCheckedAt = iso();
          skill.upstreamRevision = undefined;
          if (canonicalFiles(resolved.files) !== canonicalFiles(skill.files)) {
            skill.safety = resolved.safety;
            skill.files = clone(resolved.files);
            skill.revision = resolved.revision !== skill.revision ? resolved.revision : revision(resolved.files);
            skill.upstreamRevision = undefined;
            skill.updatedAt = iso();
            skill.versions.unshift({
              id: id("version"),
              revision: skill.revision,
              createdAt: iso(),
              message: "Updated from device-resolved source",
              files: clone(resolved.files),
            });
            bump(req.workspace!);
          }
        } else if (sourceRequest.kind === "import") {
          req.workspace!.skills.push({
            ...resolved,
            id: id("skill"),
            kind: "custom",
            source: sourceRequest.source,
            selected: true,
            enabled: true,
            autoUpdate: false,
            revision: "",
            files: [],
            draft: clone(resolved.files),
            versions: [],
            targets: [],
            updatedAt: iso(),
          });
        } else {
          if (
            req.workspace!.skills.some(
              (skill) =>
                skill.kind === "third-party" &&
                skill.source === resolved.source &&
                skill.name === resolved.name,
            )
          )
            throw httpError(409, "This skill is already installed.");
          req.workspace!.skills.push({
            ...resolved,
            id: id("skill"),
            kind: "third-party",
            selected: true,
            enabled: true,
            autoUpdate: false,
            targets: [],
            updatedAt: iso(),
            versions: [
              {
                id: id("version"),
                revision: resolved.revision,
                createdAt: iso(),
                message: "Installed from device-resolved source",
                files: clone(resolved.files),
              },
            ],
          });
          bump(req.workspace!);
        }
        requests.splice(index, 1);
        req.workspace!.sourceRequests = requests;
        activity(req.workspace!, {
          type: "source",
          title: `${resolved.title || resolved.name} resolved`,
          description: `${device.name} resolved and pinned revision ${resolved.revision}.`,
          status: sourceRequest.kind === "import" ? "pending" : "synchronized",
          deviceId: device.id,
          skillId: sourceRequest.skillId,
        });
        await saveWorkspace(db, req.accountId!, req.workspace!);
        res.json({ ok: true, accepted: true });
      } catch (error) {
        next(error);
      }
    }),
  );
  app.get("/api/device/desired", deviceIdentityAuth, workspaceHandler(async (req: AuthedRequest, res) => {
    const device = req.workspace!.devices.find((d) => d.id === req.deviceId)!;
    const etag = `"${digest(JSON.stringify([req.accountId, device.id, req.workspace!.generation, req.workspace!.sourceRequests, device.resolutions, device.instructionResolutions, device.instructionResolutionChecks, device.instructionLocations, (device as Device & { instructionUnavailable?: unknown[] }).instructionUnavailable, device.disconnect, device.excludedAgents, device.localSync?.enabled]))}"`;
    res.set({ ETag: etag, "Cache-Control": "private, no-cache" });
    if (req.headers["if-none-match"] === etag) { res.status(304).end(); return; }
    const account = await db.get<{workspace:string}>("SELECT workspace FROM accounts WHERE id=?", req.accountId!);
    const current = JSON.parse(account!.workspace);
    // Devices need current revisions, not every historical bundle and draft.
    for (const field of ["skills", "instructions"] as const) current[field] = (current[field] ?? [])
      .filter((item: Skill | Instructions) => item.selected && item.enabled && item.revision)
      .map((item: any) => ({...item,versions:[],draft:undefined,draftBundle:undefined,proposal:undefined}));
    current.retiredSkills = []; current.retiredInstructions = [];
    req.workspace = parseWorkspace(await readWorkspace(db, req.accountId!, JSON.stringify(current)));
    const skills = req
      .workspace!.skills.filter(
        (s) => s.selected && s.enabled && s.revision && s.files.length,
      )
      .map((skill) => ({
        ...skill,
        versions: [],
        draft: undefined,
        targets: skill.targets.filter((t) => t.deviceId === device.id),
      }));
    const desired: DesiredState = {
      generation: req.workspace!.generation,
      skills,
      instructions: (req.workspace!.instructions ?? []).filter(document =>
        document.selected && document.enabled && document.revision && document.files.length &&
        (!(device.instructionLocations?.length) || device.instructionLocations.some(location => instructionEnabled(document, location, device.id)) || (device.instructionUnavailable ?? []).some(location => instructionEnabled(document, location, device.id))))
        .map(document => ({ ...document, versions: [], draft: undefined,
          targets: document.targets.filter(target => target.deviceId === device.id) })),
      instructionResolutions: device.instructionResolutions ?? {},
      instructionResolutionChecks: device.instructionResolutionChecks ?? {},
      sourceRequests: req.workspace!.sourceRequests ?? [],
      resolutions: device.resolutions ?? {},
      disconnect: device.disconnect,
      excludedAgents: device.excludedAgents ?? [],
      localSync: device.localSync?.enabled ?? false,
      localSkills: req.workspace!.skills.map(({id,name,revision,kind}) => ({id,name,revision,kind})),
    };
    res.json(desired);
  }, true));
  app.post(
    "/api/device/heartbeat",
    deviceAuth,
    workspaceHandler(async (req: AuthedRequest, res) => {
      const device = req.workspace!.devices.find((d) => d.id === req.deviceId)!;
      device.name = String(req.body?.name ?? device.name);
      device.os = String(req.body?.os ?? device.os);
      device.arch = String(req.body?.arch ?? device.arch);
      if (req.body?.agents !== undefined) {
        validateAgents(req.body.agents);
        device.agents = req.body.agents.map((agent: Device["agents"][number]) => ({
          id: agent.id,
          name: agent.name,
          path: agent.path,
          ...(agent.profile ? { profile: agent.profile } : {}),
          ...(agent.project ? { project: agent.project } : {}),
          ...(agent.aliases ? { aliases: clone(agent.aliases) } : {}),
          ...(agent.detection ? {detection:agent.detection} : {}),
          ...(agent.detectionPath ? {detectionPath:agent.detectionPath} : {}),
        }));
      }
      if (req.body?.instructionLocations !== undefined)
        device.instructionLocations = validateInstructionLocations(req.body.instructionLocations);
      if (req.body?.instructionUnavailable !== undefined)
        (device as Device & { instructionUnavailable?: Array<{ agent: string; reason: string }> }).instructionUnavailable =
          validateInstructionUnavailable(req.body.instructionUnavailable);
      if (typeof req.body?.localSyncPath === "string" && req.body.localSyncPath.length <= 2048)
        device.localSync = { ...device.localSync, enabled: device.localSync?.enabled ?? false, path: req.body.localSyncPath };
      if (typeof req.body?.localSyncError === "string")
        device.localSync = { ...device.localSync, enabled: device.localSync?.enabled ?? false, error: req.body.localSyncError.slice(0, 1000) || undefined };
      device.lastSeen = iso();
      device.online = true;
      await saveWorkspace(db, req.accountId!, req.workspace!);
      res.json({ ok: true });
    }),
  );
  app.post(
    "/api/device/receipts",
    deviceAuth,
    workspaceHandler(async (req: AuthedRequest, res, next) => {
      try {
        const device = req.workspace!.devices.find(
          (d) => d.id === req.deviceId,
        )!;
        if (!Number.isInteger(req.body?.generation))
          throw httpError(400, "generation is required.");
        validateReceipts(req.body?.receipts);
        const receipts = req.body.receipts as Receipt[];
        const resolutionErrors: Array<{
          skillId: string;
          agent: string;
          message: string;
        }> = [];
        const previous = JSON.stringify(
          device.receipts.map(({ timestamp, ...receipt }) => receipt),
        );
        const resolutions = device.resolutions ?? {};
        for (const receipt of receipts) {
          if (receipt.kind === "instructions") {
            const key = instructionKey(receipt.skillId, receipt);
            const action = device.instructionResolutions?.[key];
            if (!action) continue;
            const document = (req.workspace!.instructions ?? []).find(item => item.id === receipt.skillId);
            const check = device.instructionResolutionChecks?.[key];
            const localRevision = receipt.localFiles ? revision(receipt.localFiles) : undefined;
            const reportedAction = (receipt as Receipt & { instructionResolution?: string }).instructionResolution;
            const applied = reportedAction === action && (action === "replace"
              ? receipt.status === "synchronized" && (!document || receipt.revision === document.revision)
              : receipt.status === "conflicted" && receipt.localFiles !== undefined && (!check || check === localRevision));
            if (!applied || receipt.status === "failed" || receipt.status === "offline") continue;
            if (action === "import") {
              try {
                validateInstructionFiles(receipt.localFiles, "AGENTS.md");
                const importedFiles = canonicalInstructionFiles(receipt.localFiles!);
                const importTarget = document ?? req.workspace!.instructions?.[0];
                if (importTarget?.draft && !sameFiles(importTarget.draft, importedFiles))
                  throw httpError(409, "The saved instruction draft changed after this import was queued.");
                if (importTarget) {
                  importTarget.draft = importedFiles;
                  importTarget.updatedAt = iso();
                } else {
                  req.workspace!.instructions!.push({
                    id: id("instruction"), title: "Imported instructions", filename: "AGENTS.md",
                    scope: "global", selected: true, enabled: true,
                    revision: "", files: [], draft: importedFiles, versions: [], targets: [], updatedAt: iso(),
                  });
                }
              } catch (error: any) {
                resolutionErrors.push({ skillId: receipt.skillId, agent: receipt.agent, message: error.message });
                continue;
              }
            }
            if (document && (action === "preserve" || action === "import")) {
              const existing = document.targets.find(target => target.deviceId === device.id && sameDestination(target, receipt));
              if (existing) existing.enabled = false;
              else document.targets.push({ deviceId: device.id, agent: receipt.agent, profile: receipt.profile,
                project: receipt.project, enabled: false });
            }
            delete device.instructionResolutions?.[key];
            delete device.instructionResolutionChecks?.[key];
            bump(req.workspace!);
            continue;
          }
          const key = resolutionKey(
            receipt.skillId,
            receipt.agent,
            receipt.profile,
            receipt.project,
          );
          const legacyKey = `${receipt.skillId}:${receipt.agent}`;
          const action = resolutions[key] ?? resolutions[legacyKey];
          if (!action) continue;
          const original = req.workspace!.skills.find(
            (skill) => skill.id === receipt.skillId,
          );
          const applied = action === "replace"
            ? receipt.status === "synchronized" &&
              (!original || receipt.revision === original.revision)
            : receipt.status === "conflicted" &&
              receipt.localFiles !== undefined;
          if (!applied || receipt.status === "failed" || receipt.status === "offline")
            continue;
          if (original && (action === "preserve" || action === "import")) {
            const existing = original.targets.find(
              (target) =>
                target.deviceId === device.id &&
                sameDestination(target, receipt),
            );
            if (existing) existing.enabled = false;
            else
              original.targets.push({
                deviceId: device.id,
                agent: receipt.agent,
                profile: receipt.profile,
                project: receipt.project,
                enabled: false,
              });
          }
          if (action === "import") {
            if (!receipt.localFiles?.length) {
              const message = "There are no local files to import.";
              resolutionErrors.push({
                skillId: receipt.skillId,
                agent: receipt.agent,
                message,
              });
              activity(req.workspace!, {
                type: "import-failed",
                title: "Local skill could not be imported",
                description: message,
                status: "failed",
                deviceId: device.id,
                skillId: receipt.skillId,
              });
              continue;
            }
            const importedFiles = clone(receipt.localFiles);
            let validMetadata:
              | { name: string; description: string }
              | undefined;
            try {
              validMetadata = validateFiles(importedFiles);
            } catch {}
            const baseName =
              original?.name ?? validMetadata?.name ?? "imported-skill";
            const candidate = (suffix: number) => {
              const ending = suffix === 1 ? "-local" : `-local-${suffix}`;
              const prefix =
                baseName.slice(0, 64 - ending.length).replace(/-+$/, "") ||
                "imported";
              return `${prefix}${ending}`;
            };
            let importedName = candidate(1);
            let suffix = 2;
            while (
              req.workspace!.skills.some((skill) => skill.name === importedName)
            )
              importedName = candidate(suffix++);
            if (validMetadata) {
              const primary = importedFiles.find(
                (file) => file.path === "SKILL.md",
              )!;
              const match = primary.content.match(
                /^---\r?\n([\s\S]*?)\r?\n---/,
              )!;
              const metadata = YAML.parse(match[1]);
              metadata.name = importedName;
              primary.content = primary.content.replace(
                /^---\r?\n[\s\S]*?\r?\n---/,
                `---\n${YAML.stringify(metadata).trim()}\n---`,
              );
            }
            req.workspace!.skills.push({
              id: id("skill"),
              name: importedName,
              title: `${original?.title ?? baseName} local copy`,
              description:
                validMetadata?.description ??
                original?.description ??
                "Imported local files for recovery.",
              author: req.workspace!.name,
              source: `local://${device.id}/${receipt.agent}/${baseName}`,
              kind: "custom",
              category: original?.category ?? "Imported",
              icon: original?.icon ?? "document",
              color: original?.color ?? "blue",
              selected: true,
              enabled: true,
              autoUpdate: false,
              revision: "",
              versions: [],
              files: [],
              draft: importedFiles,
              requirements: [],
              targets: [
                {
                  deviceId: device.id,
                  agent: receipt.agent,
                  profile: receipt.profile,
                  project: receipt.project,
                  enabled: false,
                },
              ],
              updatedAt: iso(),
            });
          }
          delete resolutions[key];
          delete resolutions[legacyKey];
          bump(req.workspace!);
        }
        device.resolutions = resolutions;
        device.receipts = receipts;
        device.lastSeen = iso();
        device.online = true;
        const expected = req
          .workspace!.skills.filter(
            (skill) =>
              skill.selected &&
              skill.enabled &&
              skill.revision,
          )
          .flatMap((skill) =>
            device.agents
              .filter((agent) => {
                const override = skill.targets.find(
                  (target) =>
                    target.deviceId === device.id &&
                    sameDestination(target, agent),
                );
                return override?.enabled !== false && !device.excludedAgents?.some(excluded =>
                  excluded.agent === agent.id && excluded.profile === agent.profile && excluded.project === agent.project);
              })
              .map((agent) => ({ skill, agent })),
          );
        const expectedInstructions = (req.workspace!.instructions ?? []).flatMap(document =>
          (device.instructionLocations ?? [])
            .filter(location => instructionEnabled(document, location, device.id) && document.revision && document.files.length &&
              !device.excludedAgents?.some(excluded => excluded.agent === location.agent && excluded.profile === location.profile && excluded.project === location.project))
            .map(location => ({ document, location })));
        const activeInstructions = (req.workspace!.instructions ?? []).some(document =>
          document.selected && document.enabled && document.revision && document.files.length);
        const instructionCapabilityReported = device.instructionLocations !== undefined ||
          (device as Device & { instructionUnavailable?: unknown[] }).instructionUnavailable !== undefined;
        const complete =
          req.body.generation === req.workspace!.generation &&
          (!activeInstructions || instructionCapabilityReported) &&
          !receipts.some((receipt) => receipt.status !== "synchronized") &&
          expected.every(({ skill, agent }) =>
            receipts.some(
              (receipt) =>
                receipt.skillId === skill.id &&
                sameDestination(
                  {
                    deviceId: device.id,
                    agent: receipt.agent,
                    profile: receipt.profile,
                    project: receipt.project,
                    enabled: true,
                  },
                  agent,
                ) &&
                receipt.revision === skill.revision &&
              receipt.status === "synchronized",
            ),
          ) && expectedInstructions.every(({ document, location }) => receipts.some(receipt =>
            receipt.kind === "instructions" && receipt.skillId === document.id &&
            receipt.agent === location.agent && receipt.profile === location.profile &&
            receipt.project === location.project && receipt.revision === document.revision &&
            receipt.status === "synchronized"));
        if (complete) {
          device.lastSync = iso();
          device.appliedGeneration = req.body.generation;
        }
        const changed =
          previous !==
          JSON.stringify(receipts.map(({ timestamp, ...receipt }) => receipt));
        if (changed) {
          const status = receipts.some(
            (receipt) => receipt.status === "conflicted",
          )
            ? "conflicted"
            : receipts.some((receipt) => receipt.status === "failed")
              ? "failed"
              : complete
                ? "synchronized"
                : "pending";
          activity(req.workspace!, {
            type: "sync",
            title: `${device.name} reported sync results`,
            description: `${receipts.filter((receipt) => receipt.status === "synchronized").length} destinations synchronized.`,
            status,
            deviceId: device.id,
          });
        }
        await saveWorkspace(db, req.accountId!, req.workspace!);
        res.json({ ok: true, resolutionErrors });
      } catch (error) {
        next(error);
      }
    }),
  );
  app.post(
    "/api/device/disconnected",
    deviceAuth,
    workspaceHandler(async (req: AuthedRequest, res) => {
      const device = req.workspace!.devices.find((d) => d.id === req.deviceId)!;
      device.online = false;
      device.disconnect = req.body?.mode === "remove" ? "remove" : "retain";
      device.disconnectedAt = iso();
      await saveWorkspace(db, req.accountId!, req.workspace!);
      await db.run(
        "UPDATE device_tokens SET revoked_at=? WHERE account_id=? AND device_id=?",
        Date.now(),
        req.accountId,
        req.deviceId,
      );
      res.json({ ok: true });
    }),
  );

  app.get("/cli/equip.cjs", (_req, res) => {
    const artifact = path.resolve("dist/equip.cjs");
    if (!fs.existsSync(artifact))
      return res
        .status(404)
        .json({ error: "CLI artifact has not been built." });
    res.type("application/octet-stream").sendFile(artifact);
  });
  app.get("/cli/manifest", async (req, res, next) => {
    try {
      const artifact = path.resolve("dist/equip.cjs");
      if (!fs.existsSync(artifact))
        throw httpError(404, "CLI artifact has not been built.");
      const compatibility = await (await upstream()).getCompatibility();
      const skillsIntegrity = await npmPackageIntegrity("skills", compatibility.version);
      res.json(await createReleaseManifest({artifact, origin:publicOrigin(req), skillsVersion:compatibility.version, skillsIntegrity}));
    } catch (error) {
      next(error);
    }
  });
  app.get("/cli/skills-version", async (_req, res, next) => {
    try {
      res.json({
        version: (await (await upstream()).getCompatibility()).version,
      });
    } catch (error) {
      next(error);
    }
  });
  app.get("/install.sh", async (req, res, next) => {
    try {
      const origin = publicOrigin(req);
      const skillsVersion = (await (await upstream()).getCompatibility())
        .version;
      res
        .type("text/x-shellscript")
        .send(shellInstaller(origin, skillsVersion));
    } catch (error) {
      next(error);
    }
  });
  app.get("/install.ps1", async (req, res, next) => {
    try {
      const origin = publicOrigin(req);
      const skillsVersion = (await (await upstream()).getCompatibility())
        .version;
      res.type("text/plain").send(powershellInstaller(origin, skillsVersion));
    } catch (error) {
      next(error);
    }
  });
  app.get("/install", (_req, res) => res.redirect("/install.sh"));
  const publicDir = options.publicDir ?? path.resolve("dist");
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir));
    app.get(/^(?!\/api|\/install|\/cli).*/, (_req, res) =>
      res.sendFile(path.join(publicDir, "index.html")),
    );
  }
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = error.status ?? 500;
    res.status(status).json({
      error:
        status >= 500
          ? "Internal server error."
          : error.message ?? "Request failed.",
    });
  });

  let updating = false;
  const runAutoUpdates = async () => {
    if (updating) return;
    updating = true;
    try {
      await limiter.cleanup();
      const accounts = await db.all<{ id: string; workspace: string }>(
        "SELECT id,workspace FROM accounts",
      );
      for (const account of accounts) {
        await runAccountLocked(account.id, async () => {
          const fresh = await db.get<any>(
            "SELECT workspace FROM accounts WHERE id=?",
            account.id,
          );
          const workspace: Workspace = parseWorkspace(await readWorkspace(db, account.id, fresh.workspace));
          let changed = false;
          for (const skill of workspace.skills.filter(
            (skill) => skill.kind === "third-party" && skill.autoUpdate,
          )) {
            try {
              const resolved: any = await resolveSource(
                skill.source,
                skill.name,
              );
              const metadata = validateFiles(resolved.files, 16_384);
              const nextRevision =
                resolved.revision && resolved.revision !== skill.revision ? resolved.revision : revision(resolved.files);
              const same = canonicalFiles(resolved.files) === canonicalFiles(skill.files);
              skill.upstreamCheckedAt = iso();
              skill.upstreamRevision =
                same ? undefined : nextRevision;
              skill.proposal = same ? undefined : {revision:nextRevision,files:clone(resolved.files),checkedAt:iso()};
              if (same) {
                changed = true;
                continue;
              }
              if (metadata.name !== skill.name) {
                const description = "The upstream skill name changed. Review and approve this update manually.";
                if (!workspace.activity.some(item => item.type === "update-review" && item.skillId === skill.id && item.description === description))
                  activity(workspace, { type: "update-review", title: `${skill.title} update needs review`, description, status: "pending", skillId: skill.id });
                changed = true;
                continue;
              }
              const safety = await resolveSafety(skill.source, metadata.name);
              skill.safety = safety;
              if (safety.status === "warn" || safety.status === "fail" || safety.status === "unavailable") {
                const description = safety.status === "unavailable"
                  ? "Security reports could not be checked. The selected revision is unchanged."
                  : "Upstream security reports contain findings. Review and approve this update manually.";
                if (!workspace.activity.some(item => item.type === "update-review" && item.skillId === skill.id && item.description === description))
                  activity(workspace, { type: "update-review", title: `${skill.title} update needs review`, description, status: "pending", skillId: skill.id });
                changed = true;
                continue;
              }
              skill.files = clone(resolved.files);
              skill.revision = nextRevision;
              skill.upstreamRevision = undefined;
              skill.proposal = undefined;
              skill.updatedAt = iso();
              skill.versions.unshift({
                id: id("version"),
                revision: nextRevision,
                createdAt: iso(),
                message: "Automatically updated from upstream",
                files: clone(resolved.files),
              });
              bump(workspace);
              activity(workspace, {
                type: "update",
                title: `${skill.title} updated`,
                description: `Revision ${nextRevision} is ready for devices.`,
                status: "pending",
                skillId: skill.id,
              });
              changed = true;
            } catch (error: any) {
              const description = error?.message ?? "Upstream update failed.";
              if (
                !workspace.activity.some(
                  (item) =>
                    item.type === "update-failed" &&
                    item.skillId === skill.id &&
                    item.description === description,
                )
              )
                activity(workspace, {
                  type: "update-failed",
                  title: `${skill.title} update failed`,
                  description,
                  status: "failed",
                  skillId: skill.id,
                });
              workspace.sourceRequests ??= [];
              if (
                !workspace.sourceRequests.some(
                  (request) => request.skillId === skill.id,
                )
              )
                workspace.sourceRequests.push({
                  id: id("source"),
                  source: skill.source,
                  name: skill.name,
                  kind: "install",
                  skillId: skill.id,
                  reason: description,
                  automatic: true,
                });
              changed = true;
            }
          }
          if (changed) await saveWorkspace(db, account.id, workspace);
        });
      }
    } finally {
      updating = false;
    }
  };
  const intervalMs = options.autoUpdateIntervalMs ?? 15 * 60_000;
  const updateTimer =
    intervalMs > 0
      ? setInterval(() => void runAutoUpdates(), intervalMs)
      : undefined;
  updateTimer?.unref();
  const close = async () => {
    if (updateTimer) clearInterval(updateTimer);
    await db.close();
  };
  return { app, db, close, runAutoUpdates };
}
