import os from "node:os";
import path from "node:path";

/**
 * Configuration, env-overridable:
 *   SERVE_MCP_HOST      default 127.0.0.1
 *   SERVE_MCP_PORT      default 7331
 *   SERVE_MCP_DATA_DIR  default ~/.local/share/serve-mcp
 *
 * The data dir is shared: multiple agents (multiple MCP processes) publish
 * into the same registry, and whichever process bound the port serves for all.
 */
export function loadConfig(overrides = {}) {
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

function expandHome(p) {
  if (p === "~" || p.startsWith("~/")) return path.join(os.homedir(), p.slice(1));
  return path.resolve(p);
}
