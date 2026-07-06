import os from "node:os";
import path from "node:path";
import type { Config } from "./types.ts";

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const host = overrides.host ?? process.env.SERVE_MCP_HOST ?? "127.0.0.1";
  const port = Number(overrides.port ?? process.env.SERVE_MCP_PORT ?? 7331);
  const dataDir = expandHome(
    overrides.dataDir ?? process.env.SERVE_MCP_DATA_DIR ?? "~/.local/share/serve-mcp"
  );
  return {
    host,
    port,
    dataDir,
    baseUrl: overrides.baseUrl ?? process.env.SERVE_MCP_BASE_URL ?? `http://${host}:${port}`,
  };
}

function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) return path.join(os.homedir(), p.slice(1));
  return path.resolve(p);
}
