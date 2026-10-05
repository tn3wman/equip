import assert from "node:assert/strict";
import test from "node:test";
import { createVercelConfig, normalizeApiUrl } from "../scripts/build-vercel.ts";

test("Vercel output requires a safe external API origin", () => {
  assert.equal(normalizeApiUrl("https://api.example.com/"), "https://api.example.com");
  assert.throws(() => normalizeApiUrl(undefined), /EQUIP_API_URL is required/);
  assert.throws(() => normalizeApiUrl("http://api.example.com"), /HTTPS origin/);
  assert.throws(() => normalizeApiUrl("https://api.example.com/base"), /without a path/);
  assert.throws(() => normalizeApiUrl("https://user:secret@api.example.com"), /without a path/);
});

test("Vercel output proxies backend paths before static files and the SPA fallback", () => {
  const config = createVercelConfig("https://api.example.com");
  assert.equal(config.version, 3);
  const catalogRoute = config.routes.findIndex(route => route.src === "/api/discover");
  const auditRoute = config.routes.findIndex(route => route.src === "/api/skills/audits");
  const backendRoute = config.routes.findIndex(route => route.src === "/api/(.*)");
  assert.ok(catalogRoute > 0 && catalogRoute < backendRoute);
  assert.ok(auditRoute > 0 && auditRoute < backendRoute);
  assert.equal(config.routes[catalogRoute].dest, "/catalog");
  assert.deepEqual(
    config.routes.filter((route) => "dest" in route && route.dest?.startsWith("https://")),
    [
      { src: "/api", dest: "https://api.example.com/api" },
      { src: "/api/(.*)", dest: "https://api.example.com/api/$1" },
      { src: "/cli", dest: "https://api.example.com/cli" },
      { src: "/cli/(.*)", dest: "https://api.example.com/cli/$1" },
      { src: "/install", dest: "https://api.example.com/install" },
      { src: "/install\\.sh", dest: "https://api.example.com/install.sh" },
      { src: "/install\\.ps1", dest: "https://api.example.com/install.ps1" },
    ],
  );
  assert.deepEqual(config.routes.at(-2), { handle: "filesystem" });
  assert.deepEqual(config.routes.at(-1), { src: "/.*", dest: "/index.html" });
});
