import type {
  DiscoveryResult,
  DiscoveryView,
  Skill,
  SkillAudit,
  SkillSafety,
} from "./types.ts";

const API = "https://skills.sh";
const PER_PAGE = 24;
const CACHE_TTL_MS = 30_000;
const CACHE_LIMIT = 64;
const AUDIT_CONCURRENCY = 5;

type Fetch = typeof fetch;

export interface DiscoveryOptions {
  fetch?: Fetch;
  token?: string;
  now?: () => Date;
}

export interface CatalogIdentity {
  source: string;
  name: string;
  id: string;
  sourceType: "github" | "well-known";
  installUrl: string;
  catalogUrl: string;
}

type CatalogRow = Record<string, unknown>;
type CacheEntry = { expires: number; value: Promise<DiscoveryResult> };
const discoveryCache = new Map<string, CacheEntry>();

function cleanSegment(value: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value).trim();
  } catch {
    return null;
  }
  if (!decoded || decoded === "." || decoded === "..") return null;
  if (!/^[A-Za-z0-9._-]+$/.test(decoded)) return null;
  return decoded;
}

/** Converts install sources into the stable ID and URLs used by skills.sh. */
export function catalogIdentity(
  source: string,
  name: string,
): CatalogIdentity | null {
  const skillName = cleanSegment(name);
  if (!skillName) return null;
  let raw = source.trim();
  if (!raw) return null;
  raw = raw.replace(/[?#].*$/, "").replace(/\.git\/?$/, "").replace(/\/+$/, "");

  if (/^https?:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (url.protocol !== "https:" || url.username || url.password || url.port)
      return null;
    if (url.hostname.toLowerCase() === "github.com") {
      const parts = url.pathname.split("/").filter(Boolean);
      const owner = cleanSegment(parts[0] ?? "");
      const repo = cleanSegment((parts[1] ?? "").replace(/\.git$/, ""));
      if (!owner || !repo) return null;
      raw = `${owner}/${repo}`;
    } else {
      // Well-known skills install from an HTTPS origin. Paths could redirect
      // audit requests away from the catalog identity and are not accepted.
      if (url.pathname !== "/" && url.pathname !== "") return null;
      raw = url.hostname.toLowerCase();
    }
  }

  const parts = raw.split("/").filter(Boolean);
  let normalizedSource: string;
  let sourceType: CatalogIdentity["sourceType"];
  let installUrl: string;
  if (parts.length === 2) {
    const owner = cleanSegment(parts[0]);
    const repo = cleanSegment(parts[1]);
    if (!owner || !repo) return null;
    normalizedSource = `${owner}/${repo}`;
    sourceType = "github";
    installUrl = `https://github.com/${normalizedSource}`;
  } else if (parts.length === 1) {
    const host = parts[0].toLowerCase();
    if (!host.includes(".") || !cleanSegment(host)) return null;
    normalizedSource = host;
    sourceType = "well-known";
    installUrl = `https://${host}`;
  } else {
    return null;
  }
  const id = `${normalizedSource}/${skillName}`;
  return {
    source: normalizedSource,
    name: skillName,
    id,
    sourceType,
    installUrl,
    catalogUrl: `${API}/${id}`,
  };
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function statusOf(value: unknown): SkillAudit["status"] {
  return value === "pass" || value === "warn" || value === "fail"
    ? value
    : "unknown";
}

export async function fetchSkillSafety(
  source: string,
  name: string,
  options: Pick<DiscoveryOptions, "fetch" | "now"> = {},
): Promise<SkillSafety> {
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  const identity = catalogIdentity(source, name);
  if (!identity)
    return {
      status: "unavailable",
      audits: [],
      checkedAt,
      error: "Unsupported catalog source",
      scope: "upstream",
    };
  const path = identity.id.split("/").map(encodeURIComponent).join("/");
  try {
    const response = await (options.fetch ?? fetch)(
      `${API}/api/v1/skills/audit/${path}`,
      { signal: AbortSignal.timeout(8_000) },
    );
    if (response.status === 404)
      return {
        status: "unscanned",
        audits: [],
        checkedAt,
        url: identity.catalogUrl,
        scope: "upstream",
      };
    if (!response.ok) throw new Error(`skills.sh returned ${response.status}`);
    const body = (await response.json()) as { audits?: unknown };
    if (!("audits" in body) || !Array.isArray(body.audits))
      throw new Error("skills.sh returned a malformed audit response");
    const rows = body.audits;
    const audits = rows.map((item): SkillAudit => {
      const row = item && typeof item === "object" ? (item as CatalogRow) : {};
      const slug = typeof row.slug === "string" && cleanSegment(row.slug)
        ? row.slug
        : "unknown";
      const status = statusOf(row.status);
      return {
        provider: typeof row.provider === "string" ? row.provider : "Unknown provider",
        slug,
        status,
        summary: typeof row.summary === "string" ? row.summary : "No audit summary provided",
        ...(typeof row.auditedAt === "string" && Number.isFinite(Date.parse(row.auditedAt))
          ? { auditedAt: row.auditedAt }
          : {}),
        ...(typeof row.riskLevel === "string" ? { riskLevel: row.riskLevel } : {}),
        ...(Array.isArray(row.categories)
          ? { categories: row.categories.filter((value): value is string => typeof value === "string") }
          : {}),
        url: `${identity.catalogUrl}/security/${encodeURIComponent(slug)}`,
      };
    });
    if (!audits.length)
      return { status: "unscanned", audits, checkedAt, url: identity.catalogUrl, scope: "upstream" };
    const status = audits.some(audit => audit.status === "fail")
      ? "fail"
      : audits.some(audit => audit.status === "warn" || audit.status === "unknown") ? "warn" : "pass";
    return { status, audits, checkedAt, url: identity.catalogUrl, scope: "upstream" };
  } catch (error) {
    return {
      status: "unavailable",
      audits: [],
      checkedAt,
      url: identity.catalogUrl,
      error: errorText(error),
      scope: "upstream",
    };
  }
}

function asRows(body: unknown, official: boolean): CatalogRow[] {
  if (!body || typeof body !== "object") return [];
  const value = body as CatalogRow;
  const direct = value.data ?? value.skills;
  if (!Array.isArray(direct)) return [];
  if (!official) return direct.filter((row): row is CatalogRow => !!row && typeof row === "object");
  return direct.flatMap(group => {
    if (!group || typeof group !== "object") return [];
    const row = group as CatalogRow;
    const skills = Array.isArray(row.skills) ? row.skills : [row];
    return skills.filter((skill): skill is CatalogRow => !!skill && typeof skill === "object");
  });
}

function paginationOf(body: unknown, page: number, count: number) {
  const row = body && typeof body === "object" ? body as CatalogRow : {};
  const raw = row.pagination && typeof row.pagination === "object"
    ? row.pagination as CatalogRow : {};
  const total = typeof raw.total === "number" ? raw.total : count;
  const perPage = typeof raw.perPage === "number" ? raw.perPage : PER_PAGE;
  return {
    page: typeof raw.page === "number" ? raw.page : page,
    perPage,
    total,
    hasMore: typeof raw.hasMore === "boolean" ? raw.hasMore : (page + 1) * perPage < total,
  };
}

function rowToSkill(row: CatalogRow, official: boolean, now: string): Skill | null {
  const source = typeof row.source === "string" ? row.source : "";
  const name = typeof row.slug === "string" ? row.slug
    : typeof row.skillId === "string" ? row.skillId
      : typeof row.name === "string" ? row.name : "";
  const identity = catalogIdentity(source, name);
  if (!identity) return null;
  return {
    id: identity.id,
    name: identity.name,
    title: typeof row.name === "string" ? row.name : identity.name,
    description: typeof row.description === "string" ? row.description : "",
    author: identity.sourceType === "github" ? identity.source.split("/")[0] : identity.source,
    source: identity.installUrl,
    kind: "third-party",
    category: official ? "Official" : "Community",
    icon: "Sparkles",
    color: "#7067CF",
    selected: false,
    enabled: false,
    autoUpdate: true,
    revision: "",
    versions: [],
    files: [],
    requirements: [],
    targets: [],
    ...(typeof row.installs === "number" ? { installs: row.installs } : {}),
    catalogId: typeof row.id === "string" ? row.id : identity.id,
    catalogUrl: identity.catalogUrl,
    sourceType: typeof row.sourceType === "string" ? row.sourceType : identity.sourceType,
    official,
    duplicate: row.isDuplicate === true,
    updatedAt: now,
  };
}

async function mapLimit<T, R>(values: T[], limit: number, fn: (value: T) => Promise<R>) {
  const output = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      output[index] = await fn(values[index]);
    }
  }));
  return output;
}

async function requestDiscovery(
  query: string,
  view: DiscoveryView,
  page: number,
  options: DiscoveryOptions,
): Promise<DiscoveryResult> {
  const requestFetch = options.fetch ?? fetch;
  const token = options.token?.trim();
  const search = query.trim();
  const requestedOfficial = view === "official";
  if (!token && !search)
    return { skills: [], live: false, error: "A Vercel OIDC token is required to browse skills.sh." };
  try {
    let endpoint: string;
    let authenticated = false;
    const searching = search.length >= 2;
    const curated = Boolean(token) && !searching && requestedOfficial;
    if (token && searching) {
      endpoint = `${API}/api/v1/skills/search?q=${encodeURIComponent(search)}&limit=${PER_PAGE}`;
      authenticated = true;
    } else if (curated) {
      endpoint = `${API}/api/v1/skills/curated`;
      authenticated = true;
    } else if (token) {
      endpoint = `${API}/api/v1/skills?view=${encodeURIComponent(view)}&page=${page}&per_page=${PER_PAGE}`;
      authenticated = true;
    } else {
      endpoint = `${API}/api/search?q=${encodeURIComponent(search)}&limit=${PER_PAGE}`;
    }
    const response = await requestFetch(endpoint, {
      ...(authenticated ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`skills.sh returned ${response.status}`);
    const body = await response.json();
    let rows = asRows(body, curated);
    if (curated) rows = rows.slice(page * PER_PAGE, (page + 1) * PER_PAGE);
    const now = (options.now?.() ?? new Date()).toISOString();
    const skills = rows.map(row => rowToSkill(row, curated, now)).filter((skill): skill is Skill => skill !== null);
    const withSafety = await mapLimit(skills, AUDIT_CONCURRENCY, async skill => ({
      ...skill,
      safety: await fetchSkillSafety(skill.source, skill.name, options),
    }));
    const pagination = curated
      ? { page, perPage: PER_PAGE, total: asRows(body, true).length, hasMore: (page + 1) * PER_PAGE < asRows(body, true).length }
      : searching ? undefined : paginationOf(body, page, skills.length);
    return { skills: withSafety, live: true, ...(pagination ? { pagination } : {}) };
  } catch (error) {
    return { skills: [], live: false, error: errorText(error) };
  }
}

export function discoverSkills(
  query = "",
  view: DiscoveryView = "all-time",
  page = 0,
  options: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const normalizedPage = Number.isInteger(page) && page >= 0 ? page : 0;
  if (options.fetch) return requestDiscovery(query, view, normalizedPage, options);
  const key = `${query.trim()}\0${view}\0${normalizedPage}\0${Boolean(options.token)}`;
  const now = Date.now();
  const cached = discoveryCache.get(key);
  if (cached && cached.expires > now) return cached.value;
  const value = requestDiscovery(query, view, normalizedPage, options);
  discoveryCache.set(key, { expires: now + CACHE_TTL_MS, value });
  value.then(result => {
    if (!result.live) discoveryCache.delete(key);
  }, () => discoveryCache.delete(key));
  while (discoveryCache.size > CACHE_LIMIT)
    discoveryCache.delete(discoveryCache.keys().next().value!);
  return value;
}
