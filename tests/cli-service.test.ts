import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enableService,
  serviceDefinition,
  serviceRemoval,
  upgradeRecordedService,
  withServiceLock,
} from "../cli/service.ts";

test("service definitions use absolute Node and CLI paths on every platform", async () => {
  const values = {
    home: "/tmp/home",
    nodePath: "/opt/node/bin/node",
    uid: 501,
    pathEnvironmentNames: [],
  };
  const mac = await serviceDefinition(
    "/opt/equip/equip.cjs",
    "/tmp/equip & state",
    "https://equip.test?a=1&b=2",
    { ...values, platform: "darwin" },
  );
  assert.match(
    mac.content,
    /<string>\/opt\/node\/bin\/node<\/string><string>\/opt\/equip\/equip.cjs<\/string>/,
  );
  assert.match(mac.content, /&amp;/);
  const linux = await serviceDefinition(
    "/opt/equip/equip cli.cjs",
    "/tmp/equip state",
    "https://equip.test",
    { ...values, platform: "linux" },
  );
  assert.match(
    linux.content,
    /ExecStart="\/opt\/node\/bin\/node" "\/opt\/equip\/equip cli.cjs" worker/,
  );
  assert.equal(
    linux.enableCommands[0].join(" "),
    "systemctl --user daemon-reload",
  );
  const windows = await serviceDefinition(
    "C:\\Equip App\\equip.cjs",
    "C:\\Equip State",
    "https://equip.test",
    { ...values, nodePath: "C:\\Node\\node.exe", platform: "win32" },
  );
  assert.match(
    windows.content,
    /"C:\\Node\\node.exe" "C:\\Equip App\\equip.cjs" worker/,
  );
  assert.equal(windows.bootCommands?.[0][0], "powershell.exe");
});

const windowsValues = {
  home: "C:\\Users\\Pat O'Brien",
  nodePath: "C:\\Node\\node.exe",
  uid: 501,
  pathEnvironmentNames: [],
  platform: "win32" as const,
};
const linuxValues = {
  home: "/tmp/home",
  nodePath: "/opt/node/bin/node",
  uid: 501,
  pathEnvironmentNames: [],
  platform: "linux" as const,
};
const decode = (encoded: string) =>
  Buffer.from(encoded, "base64").toString("utf16le");
const windowsDefinition = (equipHome = "C:\\Equip State") =>
  serviceDefinition("C:\\Equip\\equip.cjs", equipHome, "https://equip.test", windowsValues);

test("Windows worker registers at startup as the user without a session", async () => {
  const windows = await windowsDefinition("C:\\Users\\Pat O'Brien\\.equip");
  assert.deepEqual(windows.enableCommands, []);
  assert.equal(windows.bootCommands?.length, 1);
  const [file, ...args] = windows.bootCommands![0];
  assert.equal(file, "powershell.exe");
  assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  const script = decode(args[3]);
  const task = `Equip Sync ${windows.label.split(".").pop()}`;
  assert.match(windows.path, /Pat O'Brien.+equip-service\.cmd$/);
  // The action path is double-quoted for spaces inside a single-quoted PowerShell string.
  const quotedPath = `'"${windows.path.replace(/'/g, "''")}"'`;
  assert.ok(script.includes(`New-ScheduledTaskAction -Execute ${quotedPath}\n`));
  assert.match(script, /^\$ErrorActionPreference='Stop'/);
  assert.match(script, /New-ScheduledTaskTrigger -AtStartup/);
  assert.match(script, /New-ScheduledTaskTrigger -AtLogOn -User \$me/);
  assert.match(script, /New-ScheduledTaskPrincipal -UserId \$me -LogonType S4U -RunLevel Limited/);
  assert.match(script, /-MultipleInstances IgnoreNew/);
  assert.match(script, /-ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/);
  assert.ok(script.includes(`Register-ScheduledTask -TaskName '${task}' `));
  assert.match(script, / -Force/);
  assert.ok(script.includes(`try { Start-ScheduledTask -TaskName '${task}' } catch {}`));
  assert.match(windows.content, /set "GCM_INTERACTIVE=never"\r\nset "GIT_TERMINAL_PROMPT=0"\r\n/);
  assert.deepEqual(windows.fallbackCommands, [
    ["schtasks", "/Create", "/F", "/SC", "ONLOGON", "/TN", task, "/TR", `"${windows.path}"`],
    ["schtasks", "/Run", "/TN", task],
  ]);
});

test("Windows worker escapes typographic quotes that PowerShell treats as quotes", async () => {
  const windows = await windowsDefinition("C:\\Users\\o\u2019brien");
  const script = decode(windows.bootCommands![0][4]);
  assert.ok(script.includes("o\u2019\u2019brien"));
});

function recorder(failing: (file: string, args: string[]) => boolean) {
  const calls: string[][] = [];
  const run = async (file: string, args: string[]) => {
    calls.push([file, ...args]);
    if (failing(file, args)) throw new Error(`${file} failed`);
  };
  return { calls, run };
}

test("Windows registration records startup when the boot task is accepted", async () => {
  const windows = await windowsDefinition();
  const { calls, run } = recorder(() => false);
  assert.equal(await enableService(windows, run), "startup");
  assert.deepEqual(calls, windows.bootCommands);
});

test("Windows registration falls back to the logon task when the boot task is refused", async () => {
  const windows = await windowsDefinition();
  const { calls, run } = recorder((file) => file === "powershell.exe");
  assert.equal(await enableService(windows, run), "logon");
  assert.deepEqual(calls, [...windows.bootCommands!, ...windows.fallbackCommands!]);
});

test("Windows registration fails when both registrations are refused", async () => {
  const { run } = recorder(() => true);
  await assert.rejects(enableService(await windowsDefinition(), run), /schtasks failed/);
});

test("Linux records startup only when lingering is enabled", async () => {
  const linux = await serviceDefinition("/opt/equip/equip.cjs", "/tmp/equip", "https://equip.test", linuxValues);
  const accepted = recorder(() => false);
  assert.equal(await enableService(linux, accepted.run), "startup");
  assert.deepEqual(accepted.calls, [...linux.enableCommands, ["loginctl", "enable-linger"]]);
  const refused = recorder((file) => file === "loginctl");
  assert.equal(await enableService(linux, refused.run), "logon");
  const systemdFailure = recorder((file) => file === "systemctl");
  await assert.rejects(enableService(linux, systemdFailure.run), /systemctl failed/);
  assert.equal(systemdFailure.calls.some(([file]) => file === "loginctl"), false);
});

test("macOS records no boot mode", async () => {
  const mac = await serviceDefinition("/opt/equip/equip.cjs", "/tmp/equip", "https://equip.test", { ...linuxValues, platform: "darwin" });
  const { run } = recorder(() => false);
  assert.equal(await enableService(mac, run), undefined);
});

async function legacyWindowsInstall() {
  const equipHome = await mkdtemp(join(tmpdir(), "equip service "));
  const definition = await windowsDefinition(equipHome);
  const legacy = { path: join(equipHome, "equip-worker.cmd"), label: definition.label };
  await writeFile(legacy.path, `@echo off\r\nset "EQUIP_HOME=${equipHome}"\r\n`);
  return { equipHome, definition, legacy };
}

/** In-memory stand-in for state.json's service record. */
function store(record: { path: string; label: string; mode?: "startup" | "logon" }, connected = true) {
  const saved: (typeof record)[] = [];
  let removed = 0;
  return {
    get: () => record,
    saved,
    removed: () => removed,
    load: async () => record,
    save: async (next: typeof record) => {
      if (!connected) return false;
      saved.push(next);
      record = next;
      return true;
    },
    remove: async () => { removed++; },
  };
}
const exists = (path: string) => stat(path).then(() => true, () => false);
function upgrade(
  equipHome: string,
  definition: Awaited<ReturnType<typeof serviceDefinition>>,
  state: ReturnType<typeof store>,
  run: (file: string, args: string[]) => Promise<unknown>,
  retryLogon = false,
) {
  return upgradeRecordedService({ equipHome, definition: async () => definition, load: state.load, save: state.save, remove: state.remove, run, retryLogon });
}

test("Windows upgrade re-points the task at a new script and keeps the legacy one until disconnect", async (t) => {
  const { equipHome, definition, legacy } = await legacyWindowsInstall();
  t.after(() => rm(equipHome, { recursive: true, force: true }));
  const state = store(legacy);
  const { calls, run } = recorder(() => false);
  const upgraded = await upgrade(equipHome, definition, state, run);
  assert.deepEqual(upgraded, { path: definition.path, label: legacy.label, mode: "startup" });
  assert.deepEqual(state.get(), upgraded);
  assert.deepEqual(calls, definition.bootCommands);
  assert.equal(await readFile(definition.path, "utf8"), definition.content);
  assert.equal(await exists(legacy.path), true);
});

test("Windows upgrade refusal keeps the legacy task, script, and path and records logon", async (t) => {
  const { equipHome, definition, legacy } = await legacyWindowsInstall();
  t.after(() => rm(equipHome, { recursive: true, force: true }));
  const before = await readFile(legacy.path, "utf8");
  const state = store(legacy);
  const upgraded = await upgrade(equipHome, definition, state, recorder((file) => file === "powershell.exe").run);
  assert.deepEqual(upgraded, { ...legacy, mode: "logon" });
  assert.equal(await readFile(legacy.path, "utf8"), before);
});

test("Windows upgrade reuses a complete replacement script and never rewrites it", async (t) => {
  const { equipHome, definition, legacy } = await legacyWindowsInstall();
  t.after(() => rm(equipHome, { recursive: true, force: true }));
  // An earlier attempt registered the replacement and crashed before saving state.
  const earlier = `@echo off\r\nset "EQUIP_HOME=${equipHome}"\r\n"node.exe" "equip.cjs" worker\r\n`;
  await writeFile(definition.path, earlier);
  const state = store(legacy);
  for (const failing of [true, false]) {
    await upgrade(equipHome, definition, state, recorder((file) => failing && file === "powershell.exe").run, true);
    assert.equal(await readFile(definition.path, "utf8"), earlier);
  }
  assert.equal(state.get().mode, "startup");
});

test("Windows upgrade refuses to register an incomplete replacement script", async (t) => {
  const { equipHome, definition, legacy } = await legacyWindowsInstall();
  t.after(() => rm(equipHome, { recursive: true, force: true }));
  await writeFile(definition.path, `@echo off\r\nset "EQUIP_HOME=${equipHome}"\r\n`);
  const { calls, run } = recorder(() => false);
  await assert.rejects(upgrade(equipHome, definition, store(legacy), run), /incomplete or unowned/);
  assert.deepEqual(calls, []);
});

test("Overlapping upgrades run one at a time and the loser leaves state and scripts alone", async (t) => {
  const { equipHome, definition, legacy } = await legacyWindowsInstall();
  t.after(() => rm(equipHome, { recursive: true, force: true }));
  const state = store(legacy);
  let release!: () => void;
  const registering = new Promise<void>((resolve) => (release = resolve));
  let entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const first = upgrade(equipHome, definition, state, async () => { entered(); await registering; });
  await started;
  const refused = recorder(() => true);
  assert.equal(await upgrade(equipHome, definition, state, refused.run, true), undefined);
  assert.deepEqual(refused.calls, []);
  release();
  assert.equal((await first)?.mode, "startup");
  assert.deepEqual(state.saved, [{ path: definition.path, label: legacy.label, mode: "startup" }]);
  assert.equal(await readFile(definition.path, "utf8"), definition.content);
});

test("An upgrade releases only the lock it holds", async (t) => {
  const { equipHome, definition, legacy } = await legacyWindowsInstall();
  t.after(() => rm(equipHome, { recursive: true, force: true }));
  const lockPath = join(equipHome, "service.lock");
  const taken = JSON.stringify({ pid: process.pid, token: "another-holder" });
  await upgrade(equipHome, definition, store(legacy), async () => { await writeFile(lockPath, taken); });
  assert.equal(await readFile(lockPath, "utf8"), taken);
});

test("A lock left by a dead process does not block upgrades", async (t) => {
  const { equipHome, definition, legacy } = await legacyWindowsInstall();
  t.after(() => rm(equipHome, { recursive: true, force: true }));
  await writeFile(join(equipHome, "service.lock"), JSON.stringify({ pid: 2 ** 22 + 12345 }));
  const upgraded = await upgrade(equipHome, definition, store(legacy), recorder(() => false).run);
  assert.equal(upgraded?.mode, "startup");
  assert.equal(await exists(join(equipHome, "service.lock")), false);
});

test("An upgrade that finishes after disconnect unregisters its task and records nothing", async (t) => {
  const { equipHome, definition, legacy } = await legacyWindowsInstall();
  t.after(() => rm(equipHome, { recursive: true, force: true }));
  const state = store(legacy, false);
  assert.equal(await upgrade(equipHome, definition, state, recorder(() => false).run), undefined);
  assert.equal(state.removed(), 1);
  assert.deepEqual(state.saved, []);
  const refusedState = store(legacy, false);
  await upgrade(equipHome, definition, refusedState, recorder(() => true).run);
  assert.equal(refusedState.removed(), 0);
});

test("A malformed lock is held while fresh and reclaimed once stale", async (t) => {
  const equipHome = await mkdtemp(join(tmpdir(), "equip-lock-"));
  t.after(() => rm(equipHome, { recursive: true, force: true }));
  const lockPath = join(equipHome, "service.lock");
  await writeFile(lockPath, '{"pid": 12');
  assert.equal(await withServiceLock(equipHome, async () => "ran"), undefined);
  const old = new Date(Date.now() - 120_000);
  await utimes(lockPath, old, old);
  assert.equal(await withServiceLock(equipHome, async () => "ran"), "ran");
  assert.equal(await exists(lockPath), false);
});

test("Install and disconnect wait for an in-flight upgrade instead of interleaving", async (t) => {
  const { equipHome, definition, legacy } = await legacyWindowsInstall();
  t.after(() => rm(equipHome, { recursive: true, force: true }));
  const order: string[] = [];
  let release!: () => void;
  const registering = new Promise<void>((resolve) => (release = resolve));
  let entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const upgrading = upgrade(equipHome, definition, store(legacy), async () => {
    entered();
    await registering;
    order.push("upgrade registered");
  });
  await started;
  const disconnecting = withServiceLock(equipHome, async () => { order.push("disconnect"); }, true);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(order, []);
  release();
  await Promise.all([upgrading, disconnecting]);
  assert.deepEqual(order, ["upgrade registered", "disconnect"]);
});

test("Upgrades skip startup services and retry logon services only when asked", async (t) => {
  const { equipHome, definition, legacy } = await legacyWindowsInstall();
  t.after(() => rm(equipHome, { recursive: true, force: true }));
  for (const [mode, retryLogon, expectCalls] of [["startup", true, 0], ["logon", false, 0], ["logon", true, 1]] as const) {
    const { calls, run } = recorder(() => false);
    await upgrade(equipHome, definition, store({ ...legacy, mode }), run, retryLogon);
    assert.equal(calls.length, expectCalls, `${mode} retry=${retryLogon}`);
  }
});

test("Windows registration treats a failed start as success once the task is registered", async () => {
  const definition = await windowsDefinition("C:\\Users\\Pat\\.equip");
  const script = Buffer.from(definition.bootCommands![0].at(-1)!, "base64").toString("utf16le");
  const register = script.indexOf("Register-ScheduledTask");
  const start = script.indexOf("try { Start-ScheduledTask");
  assert.ok(register >= 0 && start > register);
  assert.match(script, /try \{ Start-ScheduledTask -TaskName '[^']+' \} catch \{\}/);
});

test("Linux upgrade only enables lingering and never rewrites the unit", async (t) => {
  const equipHome = await mkdtemp(join(tmpdir(), "equip-linux-"));
  t.after(() => rm(equipHome, { recursive: true, force: true }));
  const linux = await serviceDefinition("/opt/equip/equip.cjs", equipHome, "https://equip.test", linuxValues);
  const current = { path: linux.path, label: linux.label };
  const accepted = recorder(() => false);
  assert.deepEqual(await upgrade(equipHome, linux, store(current), accepted.run), { ...current, mode: "startup" });
  assert.deepEqual(accepted.calls, [["loginctl", "enable-linger"]]);
  assert.equal(await exists(linux.path), false);
  assert.deepEqual(await upgrade(equipHome, linux, store(current), recorder(() => true).run), { ...current, mode: "logon" });
});

test("Windows removal accepts both the current and the legacy script", async () => {
  const removal = await serviceRemoval("C:\\Equip\\equip.cjs", "/tmp/equip", "https://equip.test", windowsValues);
  assert.deepEqual(removal.paths, [join("/tmp/equip", "equip-service.cmd"), join("/tmp/equip", "equip-worker.cmd")]);
  assert.deepEqual(removal.commands, [["schtasks", "/Delete", "/F", "/TN", `Equip Sync ${removal.label.split(".").pop()}`]]);
});

test("service definitions preserve upstream agent path configuration without credentials", async () => {
  const environment = {
    EQUIP_SKILLS_ROOT: resolve("node_modules/skills"),
    CODEX_HOME: "/Users/test/.codex-work",
    CLAUDE_CONFIG_DIR: "/Users/test/.claude-work",
    XDG_CONFIG_HOME: "/Users/test/.config-work",
    GITHUB_TOKEN: "secret-not-for-service",
  };
  const options = {
    home: "/Users/test",
    nodePath: "/opt/node/bin/node",
    uid: 501,
    environment,
  };
  for (const platform of ["darwin", "linux", "win32"] as const) {
    const definition = await serviceDefinition(
      "/opt/equip/equip.cjs",
      "/Users/test/.equip/state",
      "https://equip.test",
      { ...options, platform },
    );
    assert.match(definition.content, /CODEX_HOME/);
    assert.match(definition.content, /CLAUDE_CONFIG_DIR/);
    assert.match(definition.content, /XDG_CONFIG_HOME/);
    assert.doesNotMatch(
      definition.content,
      /GITHUB_TOKEN|secret-not-for-service/,
    );
  }
});
