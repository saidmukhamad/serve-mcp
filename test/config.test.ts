import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { loadConfig, advertiseHost } from "../src/config.ts";
import { startHttp } from "../src/http.ts";
import { readServerInfo, writeServerInfo } from "../src/server-info.ts";
import { makeDeps } from "./helpers.ts";

test("loadConfig: explicit port builds baseUrl, no port means ephemeral", () => {
  const fixed = loadConfig({ dataDir: "/tmp/x", host: "127.0.0.1", port: 8080 });
  assert.equal(fixed.port, 8080);
  assert.equal(fixed.baseUrl, "http://127.0.0.1:8080");

  const ephemeral = loadConfig({ dataDir: "/tmp/x", host: "127.0.0.1" });
  assert.equal(ephemeral.port, null);
  assert.equal(ephemeral.baseUrl, null);

  assert.throws(() => loadConfig({ dataDir: "/tmp/x", port: "not-a-port" }));
  assert.throws(() => loadConfig({ dataDir: "/tmp/x", port: 70000 }));
});

test("loadConfig: config.json in dataDir applies, env and flags override it", () => {
  const dataDir = fs.mkdtempSync("/tmp/serve-mcp-cfg-");
  fs.writeFileSync(
    `${dataDir}/config.json`,
    JSON.stringify({ host: "0.0.0.0", port: 7444, allowedRoots: ["/srv/artifacts"] })
  );

  const fromFile = loadConfig({ dataDir });
  assert.equal(fromFile.host, "0.0.0.0");
  assert.equal(fromFile.port, 7444);
  assert.deepEqual(fromFile.allowedRoots, ["/srv/artifacts"]);

  const flagWins = loadConfig({ dataDir, host: "127.0.0.1", port: 9000 });
  assert.equal(flagWins.host, "127.0.0.1");
  assert.equal(flagWins.port, 9000);

  process.env.SERVE_MCP_HOST = "192.168.1.5";
  try {
    assert.equal(loadConfig({ dataDir }).host, "192.168.1.5", "env beats file");
  } finally {
    delete process.env.SERVE_MCP_HOST;
  }

  fs.writeFileSync(`${dataDir}/config.json`, "not json{");
  assert.equal(loadConfig({ dataDir }).host, "127.0.0.1", "broken file falls back to defaults");
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("advertiseHost: loopback passes through, wildcard resolves to a real address", () => {
  assert.equal(advertiseHost("127.0.0.1"), "127.0.0.1");
  assert.equal(advertiseHost("myhost.ts.net"), "myhost.ts.net");
  const resolved = advertiseHost("0.0.0.0");
  assert.notEqual(resolved, "0.0.0.0");
  assert.ok(resolved.length > 0);
});

test("startHttp: ephemeral port binds, advertises real port, records server.json", async () => {
  const deps = makeDeps({ ephemeral: true });
  const started = await startHttp(deps);
  assert.ok(started);
  const port = new URL(started.baseUrl).port;
  assert.ok(Number(port) > 0);
  assert.equal(deps.config.baseUrl, started.baseUrl);

  const info = readServerInfo(deps.config.dataDir);
  assert.ok(info);
  assert.equal(info.baseUrl, started.baseUrl);
  assert.equal(info.pid, process.pid);

  const res = await fetch(`${started.baseUrl}/healthz`);
  assert.equal(res.status, 200);

  started.server.close();
  deps.cleanup();
});

test("startHttp: explicit busy port resolves to null", async () => {
  const first = makeDeps();
  const started = await startHttp(first);
  assert.ok(started);

  const second = makeDeps();
  second.config.port = first.config.port;
  second.config.host = first.config.host;
  const result = await startHttp(second);
  assert.equal(result, null);

  started.server.close();
  first.cleanup();
  second.cleanup();
});

test("readServerInfo: dead pid is ignored", () => {
  const { config, cleanup } = makeDeps();
  writeServerInfo(config.dataDir, { baseUrl: "http://127.0.0.1:9999", host: "127.0.0.1", port: 9999 });
  const raw = readServerInfo(config.dataDir);
  assert.ok(raw, "own pid counts as alive");

  const p = `${config.dataDir}/server.json`;
  fs.writeFileSync(p, JSON.stringify({ ...raw, pid: 999999999 }));
  assert.equal(readServerInfo(config.dataDir), null);
  cleanup();
});
