import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { loadConfig, advertiseHost, detectTailnetIPv4 } from "../src/config.ts";
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

test("advertiseHost: loopback passes through, wildcard resolves to a real address", () => {
  assert.equal(advertiseHost("127.0.0.1"), "127.0.0.1");
  assert.equal(advertiseHost("myhost.ts.net"), "myhost.ts.net");
  const resolved = advertiseHost("0.0.0.0");
  assert.notEqual(resolved, "0.0.0.0");
  assert.ok(resolved.length > 0);
});

test("detectTailnetIPv4: fingerprints and false positives", () => {
  const v4 = (address: string, netmask = "255.255.255.255") =>
    ({ address, netmask, family: "IPv4", internal: false, mac: "", cidr: null }) as never;
  const v6 = (address: string) =>
    ({ address, netmask: "", family: "IPv6", internal: false, mac: "", cidr: null, scopeid: 0 }) as never;

  // ULA fingerprint wins regardless of interface name
  assert.equal(
    detectTailnetIPv4({ utun4: [v4("100.64.0.2"), v6("fd7a:115c:a1e0::2")] }),
    "100.64.0.2"
  );
  // linux interface name
  assert.equal(detectTailnetIPv4({ tailscale0: [v4("100.101.1.5")] }), "100.101.1.5");
  // CGNAT /32 point-to-point without ULA: accepted as fallback
  assert.equal(detectTailnetIPv4({ utun9: [v4("100.70.1.1")] }), "100.70.1.1");
  // CGNAT with a wide netmask (cellular tethering shape): rejected
  assert.equal(detectTailnetIPv4({ pdp_ip0: [v4("100.70.1.1", "255.192.0.0")] }), null);
  // outside 100.64.0.0/10: rejected (100.128+ is not CGNAT)
  assert.equal(detectTailnetIPv4({ eth0: [v4("100.128.0.1")] }), null);
  assert.equal(detectTailnetIPv4({ eth0: [v4("192.168.1.7", "255.255.255.0")] }), null);
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
