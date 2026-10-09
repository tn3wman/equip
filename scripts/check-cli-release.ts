import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { compareReleaseVersions } from "../shared/release.ts";

const exec = promisify(execFile);
const releaseVersionPattern = /CLI_RELEASE_VERSION\s*=\s*["']([^"']+)["']/;

function releaseVersion(source: string): string {
  const match = source.match(releaseVersionPattern);
  if (!match) throw new Error("Could not read CLI_RELEASE_VERSION from shared/release.ts.");
  return match[1];
}

async function cliInputs(treeRoot: string, dependencyRoot: string): Promise<Set<string>> {
  const result = await build({
    absWorkingDir: treeRoot,
    entryPoints: ["cli/index.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22.20",
    external: ["skills"],
    nodePaths: [join(dependencyRoot, "node_modules")],
    metafile: true,
    write: false,
    logLevel: "silent",
  });
  return new Set(
    Object.keys(result.metafile.inputs)
      .map((input) => relative(treeRoot, resolve(treeRoot, input)).replaceAll("\\", "/"))
      .filter((input) => input !== ".." && !input.startsWith("../")),
  );
}

async function git(root: string, args: string[], trim = true): Promise<string> {
  const output = (await exec("git", args, { cwd: root })).stdout;
  return trim ? output.trim() : output;
}

export async function checkCliRelease(baseRef: string, root = process.cwd()): Promise<string> {
  if (/^0+$/.test(baseRef))
    return "Skipping CLI release check because this push has no base commit.";

  const base = await git(root, ["rev-parse", "--verify", `${baseRef}^{commit}`]);
  const temporary = await mkdtemp(join(tmpdir(), "equip-cli-release-"));
  const archive = join(temporary, "base.tar");
  const baseTree = join(temporary, "base");
  try {
    await exec("git", ["archive", "--format=tar", `--output=${archive}`, base], { cwd: root });
    await mkdir(baseTree);
    await exec("tar", ["-xf", archive, "-C", baseTree]);

    const [baseInputs, currentInputs, changedOutput, statusOutput, baseRelease, currentRelease] =
      await Promise.all([
        cliInputs(baseTree, root),
        cliInputs(root, root),
        git(root, ["diff", "--name-only", "--no-renames", "-z", base, "--"], false),
        git(root, ["status", "--porcelain", "-z", "--untracked-files=all"], false),
        git(root, ["show", `${base}:shared/release.ts`]),
        readFile(join(root, "shared/release.ts"), "utf8"),
      ]);

    const changed = new Set(changedOutput.split("\0").filter(Boolean));
    for (const entry of statusOutput.split("\0").filter(Boolean)) {
      if (entry.startsWith("?? ")) changed.add(entry.slice(3));
    }

    const bundledInputs = new Set([...baseInputs, ...currentInputs]);
    const reasons = [...changed].filter((path) => bundledInputs.has(path));
    if (changed.has("package-lock.json")) reasons.push("package-lock.json");

    const basePackage = JSON.parse(await git(root, ["show", `${base}:package.json`]));
    const currentPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    if (basePackage.scripts?.["build:cli"] !== currentPackage.scripts?.["build:cli"])
      reasons.push("package.json build:cli");

    if (reasons.length === 0) return "CLI release version unchanged because the bundle is unaffected.";

    const previous = releaseVersion(baseRelease);
    const current = releaseVersion(currentRelease);
    if (compareReleaseVersions(current, previous) <= 0) {
      throw new Error(
        `CLI bundle inputs changed (${[...new Set(reasons)].sort().join(", ")}), but CLI_RELEASE_VERSION ` +
          `must be newer than ${previous}; found ${current}.`,
      );
    }
    return `CLI release version advanced from ${previous} to ${current}.`;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  const baseRef = process.argv[2];
  if (!baseRef) {
    console.error("Usage: npm run check:cli-release -- <base-commit-or-ref>");
    process.exitCode = 2;
  } else {
    checkCliRelease(baseRef)
      .then((message) => console.log(message))
      .catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
      });
  }
}
