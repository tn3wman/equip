import assert from "node:assert/strict";
import test from "node:test";
import {
  catalogIdentity,
  discoverSkills,
  fetchSkillSafety,
} from "../shared/discovery.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

test("catalogIdentity normalizes supported sources and rejects unsafe URLs", () => {
  assert.deepEqual(catalogIdentity("vercel-labs/skills", "find-skills"), {
    source: "vercel-labs/skills",
    name: "find-skills",
    id: "vercel-labs/skills/find-skills",
    sourceType: "github",
    installUrl: "https://github.com/vercel-labs/skills",
    catalogUrl: "https://skills.sh/vercel-labs/skills/find-skills",
  });
  assert.equal(
    catalogIdentity("https://github.com/vercel-labs/skills.git/tree/main", "find-skills")?.id,
    "vercel-labs/skills/find-skills",
  );
  assert.equal(catalogIdentity("https://mintlify.com", "mintlify")?.sourceType, "well-known");
  assert.equal(catalogIdentity("http://mintlify.com", "mintlify"), null);
  assert.equal(catalogIdentity("https://user:pass@mintlify.com", "mintlify"), null);
  assert.equal(catalogIdentity("https://mintlify.com/path", "mintlify"), null);
  assert.equal(catalogIdentity("../private", "skill"), null);
  assert.equal(catalogIdentity("owner/repo", "%zz"), null);
});

test("fetchSkillSafety normalizes providers and uses the worst verdict", async () => {
  const safety = await fetchSkillSafety("vercel-labs/skills", "find-skills", {
    now: () => new Date("2026-01-01T00:00:00Z"),
    fetch: async () => json({ audits: [
      { provider: "Socket", slug: "socket", status: "pass", summary: "No alerts", riskLevel: "NONE" },
      { provider: "Snyk", slug: "snyk", status: "warn", summary: "Review", auditedAt: "2025-12-01" },
    ] }),
  });
  assert.equal(safety.status, "warn");
  assert.equal(safety.checkedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(safety.audits[0].url, "https://skills.sh/vercel-labs/skills/find-skills/security/socket");
  assert.equal(safety.audits[0].riskLevel, "NONE");
  assert.equal(safety.audits[1].auditedAt, "2025-12-01");
});

test("unknown audit labels require review without claiming a dangerous result", async () => {
  const safety = await fetchSkillSafety("mintlify.com", "mintlify", {
    fetch: async () => json({ audits: [
      { provider: "New scanner", slug: "new-scanner", status: "safe-ish", summary: "New verdict" },
      { provider: "Socket", slug: "socket", status: "pass", summary: "No alerts" },
    ] }),
  });
  assert.equal(safety.status, "warn");
  assert.equal(safety.audits[0].status, "unknown");
});

test("404 is unscanned and transport errors are unavailable", async () => {
  const unscanned = await fetchSkillSafety("mintlify.com", "mintlify", {
    fetch: async () => json({ error: "not_found" }, 404),
  });
  assert.equal(unscanned.status, "unscanned");
  const unavailable = await fetchSkillSafety("mintlify.com", "mintlify", {
    fetch: async () => { throw new Error("offline"); },
  });
  assert.equal(unavailable.status, "unavailable");
  assert.match(unavailable.error ?? "", /offline/);
});

test("an explicit empty audit list is unscanned but malformed success data is unavailable", async () => {
  const empty = await fetchSkillSafety("mintlify.com", "mintlify", {
    fetch: async () => json({ audits: [] }),
  });
  assert.equal(empty.status, "unscanned");
  const malformed = await fetchSkillSafety("mintlify.com", "mintlify", {
    fetch: async () => json({ id: "mintlify.com/mintlify" }),
  });
  assert.equal(malformed.status, "unavailable");
  assert.match(malformed.error ?? "", /malformed/);
});

test("audit fields discard invalid dates", async () => {
  const safety = await fetchSkillSafety("mintlify.com", "mintlify", {
    fetch: async () => json({ audits: [
      { provider: "Socket", slug: "socket", status: "pass", summary: "No alerts", auditedAt: "not-a-date" },
    ] }),
  });
  assert.equal(safety.audits[0].auditedAt, undefined);
});

test("authenticated browse passes view and pagination and audits at most five rows", async () => {
  let active = 0;
  let maximum = 0;
  const seen: Array<{ url: string; authorization: string | null }> = [];
  const request = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    seen.push({ url, authorization: headers.get("authorization") });
    if (url.includes("/audit/")) {
      active++;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active--;
      return json({ audits: [{ provider: "Socket", slug: "socket", status: "pass", summary: "No alerts" }] });
    }
    return json({
      data: Array.from({ length: 12 }, (_, index) => ({
        id: `owner/repo/skill-${index}`,
        source: "owner/repo",
        slug: `skill-${index}`,
        name: `Skill ${index}`,
        installs: 100 - index,
        sourceType: "github",
        installUrl: "https://github.com/owner/repo",
        url: `https://skills.sh/owner/repo/skill-${index}`,
      })),
      pagination: { page: 2, perPage: 24, total: 100, hasMore: true },
    });
  };
  const result = await discoverSkills("", "hot", 2, { fetch: request as typeof fetch, token: "secret" });
  assert.equal(result.live, true);
  assert.deepEqual(result.pagination, { page: 2, perPage: 24, total: 100, hasMore: true });
  assert.equal(result.skills.length, 12);
  assert.equal(result.skills[0].official, false);
  assert.equal(result.skills[0].safety?.status, "pass");
  assert.ok(maximum <= 5);
  assert.match(seen[0].url, /view=hot&page=2&per_page=24/);
  assert.equal(seen[0].authorization, "Bearer secret");
  assert.equal(seen.slice(1).every(call => call.authorization === null), true);
});

test("official curated groups flatten, paginate locally, and alone mark skills official", async () => {
  const request = async (input: string | URL | Request) => {
    if (String(input).includes("/audit/")) return json({}, 404);
    return json({ data: [
      { owner: "maker", skills: Array.from({ length: 25 }, (_, index) => ({
        id: `maker/tools/skill-${index}`,
        source: "maker/tools",
        slug: `skill-${index}`,
        name: `Skill ${index}`,
        installs: index,
      })) },
    ] });
  };
  const result = await discoverSkills("", "official", 1, { fetch: request as typeof fetch, token: "token" });
  assert.equal(result.skills.length, 1);
  assert.equal(result.skills[0].official, true);
  assert.equal(result.skills[0].installs, 24);
  assert.deepEqual(result.pagination, { page: 1, perPage: 24, total: 25, hasMore: false });
});

test("public fallback searches without a token and never marks popularity as official", async () => {
  const calls: string[] = [];
  const request = async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/audit/")) return json({}, 404);
    return json({ skills: [{
      id: "vercel-labs/skills/find-skills",
      source: "vercel-labs/skills",
      skillId: "find-skills",
      name: "find-skills",
      installs: 3_000_000,
    }] });
  };
  const result = await discoverSkills("find-skills", "all-time", 0, { fetch: request as typeof fetch });
  assert.equal(result.live, true);
  assert.equal(result.skills[0].official, false);
  assert.equal(result.skills[0].installs, 3_000_000);
  assert.match(calls[0], /\/api\/search\?q=find-skills&limit=24/);
  assert.equal(result.pagination, undefined);
});

test("search through the official view does not label non-curated results official", async () => {
  const request = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/audit/")) return json({ audits: [] });
    assert.match(url, /\/api\/v1\/skills\/search\?q=community&limit=24/);
    return json({ data: [{
      id: "owner/repo/community",
      source: "owner/repo",
      slug: "community",
      name: "Community",
      url: "https://attacker.example/forged",
    }] });
  };
  const result = await discoverSkills("community", "official", 4, {
    fetch: request as typeof fetch,
    token: "token",
  });
  assert.equal(result.skills[0].official, false);
  assert.equal(result.skills[0].catalogUrl, "https://skills.sh/owner/repo/community");
  assert.equal(result.pagination, undefined);
});

test("browse without a token reports the live catalog as unavailable", async () => {
  let called = false;
  const result = await discoverSkills("", "all-time", 0, {
    fetch: async () => { called = true; return json({}); },
  });
  assert.equal(called, false);
  assert.equal(result.live, false);
  assert.deepEqual(result.skills, []);
  assert.match(result.error ?? "", /token is required/i);
});
