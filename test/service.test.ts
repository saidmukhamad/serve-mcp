import { test } from "node:test";
import assert from "node:assert/strict";
import {
  launchdPlist,
  systemdUnit,
  windowsLaunchVbs,
  windowsTaskXml,
  runtimeWarnings,
  SERVICE_LABEL,
} from "../src/service.ts";

const paths = {
  node: "/usr/local/bin/node",
  bin: "/opt/serve-mcp/bin/serve-mcp.js",
  dataDir: "/data",
  logFile: "/data/serve.log",
};

test("launchdPlist: reverse-DNS label, runs `serve`, keeps alive, background type", () => {
  const plist = launchdPlist(paths);
  assert.match(plist, new RegExp(`<string>${SERVICE_LABEL.replace(/\./g, "\\.")}</string>`));
  assert.match(plist, /<string>\/usr\/local\/bin\/node<\/string>/);
  assert.match(plist, /<string>\/opt\/serve-mcp\/bin\/serve-mcp\.js<\/string>/);
  assert.match(plist, /<string>serve<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /<key>ProcessType<\/key><string>Background<\/string>/);
  assert.match(plist, /<key>ThrottleInterval<\/key><integer>10<\/integer>/);
  assert.match(plist, /<string>\/data\/serve\.log<\/string>/);
});

test("systemdUnit: quoted ExecStart, restarts on failure", () => {
  const unit = systemdUnit(paths);
  assert.match(unit, /ExecStart="\/usr\/local\/bin\/node" "\/opt\/serve-mcp\/bin\/serve-mcp\.js" serve/);
  assert.match(unit, /WorkingDirectory=\/data/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /RestartSec=5/);
  assert.match(unit, /WantedBy=default\.target/);
});

test("launchdPlist: XML-escapes paths", () => {
  const plist = launchdPlist({ ...paths, bin: "/tmp/a & b/<x>/serve-mcp.js" });
  assert.match(plist, /<string>\/tmp\/a &amp; b\/&lt;x&gt;\/serve-mcp\.js<\/string>/);
  assert.doesNotMatch(plist, /a & b/);
});

test("windowsLaunchVbs: hidden window, waits, forwards exit code, logs", () => {
  const vbs = windowsLaunchVbs({
    node: "C:\\Program Files\\nodejs\\node.exe",
    bin: "C:\\Users\\x\\serve-mcp\\bin\\serve-mcp.js",
    dataDir: "C:\\Users\\x\\data",
    logFile: "C:\\Users\\x\\data\\serve.log",
  });
  assert.match(vbs, /""C:\\Program Files\\nodejs\\node\.exe"" ""C:\\Users\\x\\serve-mcp\\bin\\serve-mcp\.js"" serve/);
  assert.match(vbs, /, 0, True\)/);
  assert.match(vbs, /WScript\.Quit rc/);
  assert.match(vbs, />> ""C:\\Users\\x\\data\\serve\.log"" 2>&1/);
});

test("windowsTaskXml: current-user logon trigger, least privilege, keep-alive settings", () => {
  const xml = windowsTaskXml("C:\\Users\\x\\data\\serve-mcp-launch.vbs", "PC\\user");
  assert.match(xml, /<LogonTrigger>[\s\S]*<UserId>PC\\user<\/UserId>/);
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(xml, /<RestartOnFailure>[\s\S]*<Interval>PT1M<\/Interval>/);
  assert.match(xml, /<Command>wscript\.exe<\/Command>/);
  assert.match(xml, /<Arguments>"C:\\Users\\x\\data\\serve-mcp-launch\.vbs"<\/Arguments>/);
});

test("runtimeWarnings: old node, npx cache, version-manager paths", () => {
  assert.equal(runtimeWarnings(paths, "v22.22.0").length, 0);
  assert.match(runtimeWarnings(paths, "v18.19.0")[0]!, /below the required Node/);
  assert.match(
    runtimeWarnings({ ...paths, bin: "/Users/x/.npm/_npx/abc/node_modules/.bin/serve-mcp" }, "v22.22.0")[0]!,
    /npx cache/
  );
  assert.match(
    runtimeWarnings({ ...paths, node: "/Users/x/.nvm/versions/node/v22.22.0/bin/node" }, "v22.22.0")[0]!,
    /pins this exact runtime/
  );
});
