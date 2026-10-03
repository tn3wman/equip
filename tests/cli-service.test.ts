import assert from "node:assert/strict";
import test from "node:test";
import { serviceDefinition } from "../cli/service.ts";

test("service definitions use absolute Node and CLI paths on every platform", async () => {
  const values = {
    home: "/tmp/home",
    nodePath: "/opt/node/bin/node",
    uid: 501,
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
  assert.match(
    windows.enableCommands[1].join(" "),
    /^schtasks \/Run \/TN Equip Sync /,
  );
});
