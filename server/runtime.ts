import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);
const day = 86_400_000;

// Only validated immutable runtimes become active. A failed upstream release leaves the
// current compatibility definitions and device manifest intact.
export async function startCompatibilityUpdates(dataDir: string) {
  const root = resolve(dataDir, "upstream");
  const activePath = join(root, "active.json");
  await mkdir(root, { recursive: true });
  try {
    const active = JSON.parse(await readFile(activePath, "utf8")) as {
      version: string;
    };
    if (/^\d+\.\d+\.\d+$/.test(active.version)) {
      const packagePath = join(
        root,
        active.version,
        "node_modules/skills/package.json",
      );
      await readFile(packagePath);
      process.env.EQUIP_SKILLS_ROOT = dirname(packagePath);
    }
  } catch {
    /* First run uses the repository's tested runtime. */
  }
  let checking = false;
  let closed = false;
  const check = async () => {
    if (checking || closed) return;
    checking = true;
    let stage: string | undefined;
    try {
      const { getCompatibility } = await import("../shared/upstream.ts");
      const current = await getCompatibility();
      const response = await fetch("https://registry.npmjs.org/skills/latest", {
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok)
        throw new Error(`skills registry returned ${response.status}`);
      const latest = (await response.json()) as { version: string };
      if (!/^\d+\.\d+\.\d+$/.test(latest.version))
        throw new Error("The skills registry returned an invalid version.");
      if (latest.version === current.version) return;
      stage = join(root, `.stage-${randomUUID()}`);
      await mkdir(stage);
      const npmCli =
        process.env.npm_execpath ||
        (process.platform === "win32"
          ? join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")
          : await realpath(join(dirname(process.execPath), "npm")));
      await exec(
        process.execPath,
        [
          npmCli,
          "install",
          "--prefix",
          stage,
          "--no-audit",
          "--no-fund",
          "--ignore-scripts",
          "--save-exact",
          `skills@${latest.version}`,
        ],
        { timeout: 180_000 },
      );
      await promoteCompatibilityRuntime(stage, root, latest.version);
      stage = undefined;
      console.log(`Equip compatibility updated to Skills ${latest.version}.`);
    } catch (error) {
      console.error(
        "Equip kept its working Skills runtime:",
        (error as Error).message,
      );
    } finally {
      if (stage) await rm(stage, { recursive: true, force: true });
      checking = false;
    }
  };
  void check();
  const timer = setInterval(check, day);
  timer.unref();
  return () => {
    closed = true;
    clearInterval(timer);
  };
}

export async function promoteCompatibilityRuntime(
  stage: string,
  root: string,
  version: string,
) {
  const fixture = join(stage, "fixture");
  await mkdir(fixture);
  await writeFile(
    join(fixture, "SKILL.md"),
    "---\nname: compatibility-check\ndescription: Verify the Skills runtime before promotion.\n---\n\n# Compatibility check\n",
  );
  const adapter = pathToFileURL(resolve("shared/upstream.ts")).href;
  const validation = `import {getCompatibility,resolveSkill} from ${JSON.stringify(adapter)}; const c=await getCompatibility();if(!c.agents.length)throw new Error('No agent definitions');const s=await resolveSkill(${JSON.stringify(fixture)},'compatibility-check');if(!s.files.some(f=>f.path==='SKILL.md'))throw new Error('Source installation failed');`;
  await exec(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", validation],
    {
      env: {
        ...process.env,
        EQUIP_SKILLS_ROOT: join(stage, "node_modules/skills"),
        EQUIP_SOURCE_CACHE: join(stage, "cache"),
      },
      timeout: 180_000,
    },
  );
  await rm(fixture, { recursive: true });
  await rm(join(stage, "cache"), { recursive: true, force: true });
  const destination = join(root, version);
  await rename(stage, destination);
  const activePath = join(root, "active.json");
  const temporary = `${activePath}.tmp`;
  await writeFile(temporary, JSON.stringify({ version: version }), {
    mode: 0o600,
  });
  await rename(temporary, activePath);
  process.env.EQUIP_SKILLS_ROOT = join(destination, "node_modules/skills");
}
