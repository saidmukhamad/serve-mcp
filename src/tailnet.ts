import os from "node:os";
import dns from "node:dns/promises";
import { Resolver } from "node:dns/promises";

// Tailscale's registered ULA prefix; its presence on an interface identifies
// a tailnet without any Tailscale tooling.
const TAILSCALE_ULA = /^fd7a:115c:a1e0:/i;

// tailscaled's MagicDNS resolver (Quad100); we only ever speak standard DNS to it.
const QUAD100 = "100.100.100.100";

export function isCgnat(addr: string): boolean {
  const [a, b] = addr.split(".").map(Number);
  return a === 100 && b! >= 64 && b! <= 127;
}

export function detectTailnetIPv4(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()
): string | null {
  let fallback: string | null = null;
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    const v4 = addrs.find(
      (a): a is os.NetworkInterfaceInfoIPv4 => a.family === "IPv4" && !a.internal && isCgnat(a.address)
    );
    if (!v4) continue;
    const hasUla = addrs.some((a) => a.family === "IPv6" && TAILSCALE_ULA.test(a.address));
    if (hasUla || name === "tailscale0" || name.toLowerCase().includes("tailscale")) return v4.address;
    // CGNAT + /32 point-to-point is how tailscale/wireguard meshes look;
    // a plain CGNAT address (cellular tethering) has a wider netmask.
    if (v4.netmask === "255.255.255.255") fallback ??= v4.address;
  }
  return fallback;
}

export interface DnsHooks {
  reverse?: (ip: string) => Promise<string[]>;
  lookup?: (name: string) => Promise<string[]>;
}

/**
 * MagicDNS name for a tailnet IP: PTR via Quad100, then verified through the
 * system resolver so we never advertise a name peers can't resolve. Null on
 * any failure — callers fall back to the IP.
 */
export async function resolveTailnetDnsName(ip: string, hooks: DnsHooks = {}): Promise<string | null> {
  const reverse = hooks.reverse ?? quad100Reverse;
  const lookup = hooks.lookup ?? systemLookup;
  try {
    const name = (await reverse(ip))[0]?.replace(/\.$/, "");
    if (!name) return null;
    const addrs = await lookup(name);
    return addrs.includes(ip) ? name : null;
  } catch {
    return null;
  }
}

function quad100Reverse(ip: string): Promise<string[]> {
  const resolver = new Resolver({ timeout: 1500, tries: 1 });
  resolver.setServers([QUAD100]);
  return resolver.reverse(ip);
}

async function systemLookup(name: string): Promise<string[]> {
  const results = await dns.lookup(name, { all: true, family: 4 });
  return results.map((r) => r.address);
}
