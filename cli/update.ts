import { randomUUID } from "node:crypto";
import { platform as hostPlatform } from "node:os";
import { rename, rm, writeFile } from "node:fs/promises";

export async function replaceExecutable(
  executable: string,
  data: Buffer,
  os: NodeJS.Platform = hostPlatform(),
) {
  const stage = `${executable}.${randomUUID()}.update`;
  await writeFile(stage, data, { mode: 0o755 });
  if (os !== "win32") {
    try {
      await rename(stage, executable);
    } catch (error) {
      await rm(stage, { force: true }).catch(() => {});
      throw error;
    }
    return;
  }
  const old = `${executable}.previous`;
  await rm(old, { force: true });
  await rename(executable, old);
  try {
    await rename(stage, executable);
    await rm(old, { force: true });
  } catch (error) {
    await rename(old, executable).catch(() => {});
    await rm(stage, { force: true }).catch(() => {});
    throw error;
  }
}
