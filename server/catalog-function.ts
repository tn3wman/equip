import type { IncomingMessage, ServerResponse } from "node:http";
import { getVercelOidcToken } from "@vercel/oidc";
import { discoverSkills, fetchSkillSafety } from "../shared/discovery.ts";
import type { DiscoveryView } from "../shared/types.ts";

// The catalog needs a fresh Vercel project identity. Account and device APIs stay on Railway.
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: "Use GET for the skill catalog." }));
  }
  try {
    const url = new URL(req.url ?? "/", "https://equip.invalid");
    let token: string | undefined;
    try { token = await getVercelOidcToken(); } catch { /* Public search and available reports remain usable without identity. */ }
    if (url.pathname === "/api/skills/audits") {
      const safety = await fetchSkillSafety(url.searchParams.get("source") ?? "", url.searchParams.get("name") ?? "", { token });
      res.setHeader("Cache-Control", safety.status === "unavailable" ? "no-store" : "public, max-age=30, s-maxage=60");
      return res.end(JSON.stringify(safety));
    }
    const view = url.searchParams.get("view") ?? "all-time";
    const page = Number(url.searchParams.get("page") ?? 0);
    const query = url.searchParams.get("q") ?? "";
    if (!["all-time", "trending", "hot", "official"].includes(view) || !Number.isInteger(page) || page < 0 || page > 10000 || query.length > 200) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "Invalid discovery parameters." }));
    }
    const result = await discoverSkills(query, view as DiscoveryView, page, { token });
    res.setHeader("Cache-Control", result.live ? "public, max-age=30, s-maxage=60" : "no-store");
    res.end(JSON.stringify(result));
  } catch {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: "The skills.sh catalog is temporarily unavailable." }));
  }
}
