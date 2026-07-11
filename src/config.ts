import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectTailnetIPv4 } from "./tailnet.ts";
import type { Config } from "./types.ts";

export interface ConfigOverrides {
  host?: string;
  port?: number | string;
  dataDir?: string;
  baseUrl?: string;
  allowedRoots?: string[];
  stripScripts?: boolean | string;
}

interface ConfigFile {
  host?: string;
  port?: number | string;
  baseUrl?: string;
  allowedRoots?: string[];
  stripScripts?: boolean;
}

/**
 * Precedence: CLI flags > env vars > <dataDir>/config.json > defaults.
 * The file is the intended home for a permanent setup (e.g. tailnet binding);
 * flags and env are one-off overrides.
 */
export function loadConfig(overrides: ConfigOverrides = {}): Config {
  const dataDir = expandHome(
    overrides.dataDir ?? process.env.SERVE_MCP_DATA_DIR ?? "~/.local/share/serve-mcp"
  );
  const file = readConfigFile(dataDir);

  const host = overrides.host ?? process.env.SERVE_MCP_HOST ?? file.host ?? "127.0.0.1";
  const portRaw = overrides.port ?? process.env.SERVE_MCP_PORT ?? file.port;
  const port = portRaw === undefined || portRaw === "" ? null : Number(portRaw);
  if (port !== null && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    throw new Error(`invalid port: ${portRaw}`);
  }
  const explicit = overrides.baseUrl ?? process.env.SERVE_MCP_BASE_URL ?? file.baseUrl;
  const allowedRoots =
    overrides.allowedRoots ??
    process.env.SERVE_MCP_ALLOWED_ROOTS?.split(":").filter(Boolean) ??
    file.allowedRoots;
  const stripScripts = parseBoolean(
    overrides.stripScripts ?? process.env.SERVE_MCP_STRIP_SCRIPTS ?? file.stripScripts ?? false,
    "stripScripts"
  );

  return {
    host,
    port,
    dataDir,
    baseUrl: explicit ?? (port ? `http://${advertiseHost(host)}:${port}` : null),
    baseUrlExplicit: Boolean(explicit),
    allowedRoots: allowedRoots?.map(expandHome),
    stripScripts,
  };
}

export const CONFIG_KEYS = ["host", "port", "baseUrl", "stripScripts"] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

export function configFilePath(dataDir: string): string {
  return path.join(dataDir, "config.json");
}

export function setConfigValue(dataDir: string, key: ConfigKey, value: string): ConfigFile {
  const file = readConfigFile(dataDir);
  if (value === "") {
    delete file[key];
  } else if (key === "port") {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port: ${value}`);
    file.port = port;
  } else if (key === "stripScripts") {
    file.stripScripts = parseBoolean(value, key);
  } else {
    file[key] = value;
  }
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(configFilePath(dataDir), JSON.stringify(file, null, 2) + "\n");
  return file;
}

function readConfigFile(dataDir: string): ConfigFile {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8")) as ConfigFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[serve-mcp] ignoring unreadable config.json: ${(err as Error).message}`);
    }
    return {};
  }
}

function parseBoolean(value: unknown, key: string): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    switch (value.trim().toLowerCase()) {
      case "true":
      case "1":
      case "yes":
      case "on":
        return true;
      case "false":
      case "0":
      case "no":
      case "off":
        return false;
    }
  }
  throw new Error(`invalid ${key}: ${String(value)} (expected true or false)`);
}

export function baseUrlOf(config: Config): string {
  return config.baseUrl ?? "";
}

// 0.0.0.0/:: is bindable but not linkable; advertise a reachable address.
export function advertiseHost(bindHost: string): string {
  if (bindHost !== "0.0.0.0" && bindHost !== "::") return bindHost;
  return detectTailnetIPv4() ?? firstExternalIPv4() ?? "127.0.0.1";
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
