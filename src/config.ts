import os from "node:os";
import path from "node:path";
import type { Config } from "./types.ts";

export interface ConfigOverrides {
  host?: string;
  port?: number | string;
  dataDir?: string;
  baseUrl?: string;
}

export function loadConfig(overrides: ConfigOverrides = {}): Config {
  const host = overrides.host ?? process.env.SERVE_MCP_HOST ?? "127.0.0.1";
  const portRaw = overrides.port ?? process.env.SERVE_MCP_PORT;
  const port = portRaw === undefined || portRaw === "" ? null : Number(portRaw);
  if (port !== null && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    throw new Error(`invalid port: ${portRaw}`);
  }
  const dataDir = expandHome(
    overrides.dataDir ?? process.env.SERVE_MCP_DATA_DIR ?? "~/.local/share/serve-mcp"
  );
  const explicit = overrides.baseUrl ?? process.env.SERVE_MCP_BASE_URL;
  return {
    host,
    port,
    dataDir,
    baseUrl: explicit ?? (port ? `http://${advertiseHost(host)}:${port}` : null),
  };
}

// 0.0.0.0/:: is bindable but not linkable; advertise a reachable address.
export function advertiseHost(bindHost: string): string {
  if (bindHost !== "0.0.0.0" && bindHost !== "::") return bindHost;
  return detectTailnetIPv4() ?? firstExternalIPv4() ?? "127.0.0.1";
}

// Tailscale's registered ULA prefix; its presence on an interface identifies
// a tailnet without any Tailscale tooling.
const TAILSCALE_ULA = /^fd7a:115c:a1e0:/i;

function isCgnat(addr: string): boolean {
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

function firstExternalIPv4(): string | null {
  const addrs = Object.values(os.networkInterfaces())
    .flat()
    .filter((i): i is os.NetworkInterfaceInfoIPv4 => Boolean(i && !i.internal && i.family === "IPv4"));
  const lan = addrs.find((i) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address));
  return (lan ?? addrs[0])?.address ?? null;
}

function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) return path.join(os.homedir(), p.slice(1));
  return path.resolve(p);
}
