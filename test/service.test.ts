import { test } from "node:test";
import assert from "node:assert/strict";
import { launchdPlist, systemdUnit, runtimeWarnings } from "../src/service.ts";

const paths = { node: "/usr/local/bin/node", bin: "/opt/serve-mcp/bin/serve-mcp.js", logFile: "/data/serve.log" };

test("launchdPlist: runs `serve`, keeps alive, logs to data dir", () => {
  const plist = launchdPlist(paths);
  assert.match(plist, /<string>\/usr\/local\/bin\/node<\/string>/);
  assert.match(plist, /<string>\/opt\/serve-mcp\/bin\/serve-mcp\.js<\/string>/);
  assert.match(plist, /<string>serve<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /<string>\/data\/serve\.log<\/string>/);
});

test("systemdUnit: quoted ExecStart, restarts on failure", () => {
  const unit = systemdUnit(paths);
  assert.match(unit, /ExecStart="\/usr\/local\/bin\/node" "\/opt\/serve-mcp\/bin\/serve-mcp\.js" serve/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /WantedBy=default\.target/);
});

test("launchdPlist: XML-escapes paths", () => {
  const plist = launchdPlist({ ...paths, bin: "/tmp/a & b/<x>/serve-mcp.js" });
  assert.match(plist, /<string>\/tmp\/a &amp; b\/&lt;x&gt;\/serve-mcp\.js<\/string>/);
  assert.doesNotMatch(plist, /a & b/);
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
