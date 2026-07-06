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

// 0.0.0.0/:: is bindable but not linkable; advertise a reachable address,
// preferring the Tailscale/CGNAT range (100.64.0.0/10).
export function advertiseHost(bindHost: string): string {
  if (bindHost !== "0.0.0.0" && bindHost !== "::") return bindHost;
  const addrs = Object.values(os.networkInterfaces())
    .flat()
    .filter((i): i is os.NetworkInterfaceInfoIPv4 => Boolean(i && !i.internal && i.family === "IPv4"));
  const tailscale = addrs.find((i) => {
    const [a, b] = i.address.split(".").map(Number);
    return a === 100 && b! >= 64 && b! <= 127;
  });
  return (tailscale ?? addrs[0])?.address ?? "127.0.0.1";
}

function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) return path.join(os.homedir(), p.slice(1));
  return path.resolve(p);
}
