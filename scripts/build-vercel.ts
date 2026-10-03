import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { build as bundle } from "esbuild";

const outputRoot = fileURLToPath(new URL("../.vercel/output/", import.meta.url));

type VercelRoute = {
  src?: string;
  dest?: string;
  headers?: Record<string, string>;
  continue?: boolean;
  handle?: "filesystem";
};

export function normalizeApiUrl(value: string | undefined) {
  if (!value) {
    throw new Error("EQUIP_API_URL is required for the Vercel build");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("EQUIP_API_URL must be an absolute HTTPS URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("EQUIP_API_URL must be an HTTPS origin without a path, credentials, query, or fragment");
  }
  return url.href.replace(/\/$/, "");
}

export function createVercelConfig(apiUrl: string): { version: 3; routes: VercelRoute[] } {
  const securityHeaders = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
  };
  const uncached = { "Cache-Control": "no-store" };

  return {
    version: 3,
    routes: [
      { src: "/.*", headers: securityHeaders, continue: true },
      { src: "/(?:api|cli|install)(?:/.*|\\..*)?", headers: uncached, continue: true },
      { src: "/api/discover", dest: "/catalog" },
      { src: "/api/skills/audits", dest: "/catalog" },
      { src: "/api", dest: `${apiUrl}/api` },
      { src: "/api/(.*)", dest: `${apiUrl}/api/$1` },
      { src: "/cli", dest: `${apiUrl}/cli` },
      { src: "/cli/(.*)", dest: `${apiUrl}/cli/$1` },
      { src: "/install", dest: `${apiUrl}/install` },
      { src: "/install\\.sh", dest: `${apiUrl}/install.sh` },
      { src: "/install\\.ps1", dest: `${apiUrl}/install.ps1` },
      { handle: "filesystem" },
      { src: "/.*", dest: "/index.html" },
    ],
  };
}

export async function buildVercelOutput(environment = process.env) {
  const apiUrl = normalizeApiUrl(environment.EQUIP_API_URL);
  await rm(outputRoot, { recursive: true, force: true });
  await build({ build: { outDir: `${outputRoot}/static`, emptyOutDir: true } });
  await mkdir(outputRoot, { recursive: true });
  const functionRoot = `${outputRoot}/functions/catalog.func`;
  await mkdir(functionRoot, { recursive: true });
  await bundle({
    entryPoints: [fileURLToPath(new URL("../server/catalog-function.ts", import.meta.url))],
    outfile: `${functionRoot}/index.cjs`, bundle: true, platform: "node", format: "cjs", target: "node22",
  });
  await writeFile(`${functionRoot}/.vc-config.json`, JSON.stringify({ runtime: "nodejs22.x", handler: "index.cjs", launcherType: "Nodejs" }));
  await writeFile(
    `${outputRoot}/config.json`,
    `${JSON.stringify(createVercelConfig(apiUrl), null, 2)}\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await buildVercelOutput();
}
