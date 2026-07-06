import { test } from "node:test";
import assert from "node:assert/strict";
import { detectTailnetIPv4, isCgnat, resolveTailnetDnsName } from "../src/tailnet.ts";

test("isCgnat bounds", () => {
  assert.equal(isCgnat("100.64.0.1"), true);
  assert.equal(isCgnat("100.127.255.255"), true);
  assert.equal(isCgnat("100.63.0.1"), false);
  assert.equal(isCgnat("100.128.0.1"), false);
  assert.equal(isCgnat("192.168.1.1"), false);
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

test("resolveTailnetDnsName: PTR + system verification", async () => {
  const ok = await resolveTailnetDnsName("100.64.0.2", {
    reverse: async () => ["helios.ts.example."],
    lookup: async () => ["100.64.0.2"],
  });
  assert.equal(ok, "helios.ts.example");

  // name the system resolver maps elsewhere must not be advertised
  const mismatch = await resolveTailnetDnsName("100.64.0.2", {
    reverse: async () => ["helios.ts.example"],
    lookup: async () => ["100.64.0.9"],
  });
  assert.equal(mismatch, null);

  const noPtr = await resolveTailnetDnsName("100.64.0.2", {
    reverse: async () => [],
    lookup: async () => ["100.64.0.2"],
  });
  assert.equal(noPtr, null);

  const dnsDown = await resolveTailnetDnsName("100.64.0.2", {
    reverse: async () => {
      throw new Error("ETIMEOUT");
    },
    lookup: async () => ["100.64.0.2"],
  });
  assert.equal(dnsDown, null);
});
