#!/usr/bin/env node
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../src/config.ts";
import { ArtifactStore } from "../src/store.ts";
import { Registry, artifactWithUrls, publicationWithUrls } from "../src/registry.ts";
import { startHttp, type Deps } from "../src/http.ts";
import { createMcpServer } from "../src/mcp.ts";
import { readServerInfo } from "../src/server-info.ts";
import { captureContext } from "../src/provenance.ts";

const USAGE = `serve-mcp — local MCP-controlled artifact shelf

Usage:
  serve-mcp mcp [--port <p>] [--host <h>]     run MCP server on stdio (serves HTTP too)
  serve-mcp serve [--port <p>] [--host <h>]   run the HTTP preview server only
  serve-mcp publish <path> [opts]             publish a file/folder from the CLI
  serve-mcp list                              list publications

Without --port / SERVE_MCP_PORT an ephemeral port is used and recorded in the
data dir, so other serve-mcp processes find the running shelf automatically.
Bind --host 0.0.0.0 to reach the shelf over your LAN/Tailscale network.

Publish options:
  --title <t>   --slug <s>   --update   --tag <t> (repeatable)

Env:
  SERVE_MCP_HOST (127.0.0.1)  SERVE_MCP_PORT (ephemeral)
  SERVE_MCP_DATA_DIR (~/.local/share/serve-mcp)
  SERVE_MCP_BASE_URL (advertised URL override)
  SERVE_MCP_ALLOWED_ROOTS (colon-separated publish roots)
`;

const [cmd = "mcp", ...rest] = process.argv.slice(2);

function serverFlags(args: string[]) {
  const { values } = parseArgs({
    args,
    options: { port: { type: "string" }, host: { type: "string" } },
  });
  return values;
}

function deps(config: ReturnType<typeof loadConfig>): Deps {
  return { store: new ArtifactStore(config.dataDir), registry: new Registry(config.dataDir), config };
}

if (cmd === "mcp") {
  const config = loadConfig(serverFlags(rest));
  const d = deps(config);
  const existing = config.port === null ? readServerInfo(config.dataDir) : null;
  if (existing) {
    config.baseUrl = existing.baseUrl;
    console.error(`[serve-mcp] using running shelf at ${existing.baseUrl} (pid ${existing.pid})`);
  } else {
    const started = await startHttp(d);
    if (started) {
      console.error(`[serve-mcp] shelf at ${started.baseUrl}`);
    } else {
      const info = readServerInfo(config.dataDir);
      if (info) config.baseUrl = info.baseUrl;
      console.error(
        `[serve-mcp] port ${config.port} busy — assuming another serve-mcp is serving ${config.baseUrl}`
      );
    }
  }
  const mcp = createMcpServer(d);
  await mcp.connect(new StdioServerTransport());
} else if (cmd === "serve") {
  const config = loadConfig(serverFlags(rest));
  const started = await startHttp(deps(config));
  if (!started) {
    console.error(`[serve-mcp] port ${config.port} already in use`);
    process.exit(1);
  }
  console.error(`[serve-mcp] shelf at ${started.baseUrl}`);
} else if (cmd === "publish") {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      title: { type: "string" },
      slug: { type: "string" },
      update: { type: "boolean", default: false },
      tag: { type: "string", multiple: true },
    },
  });
  const target = positionals[0];
  if (!target) {
    console.error(USAGE);
    process.exit(1);
  }
  const config = loadConfig();
  const d = deps(config);
  const baseUrl = resolveBaseUrl(config);
  const ingested = d.store.ingest({ type: "path", path: target });
  const { publication, artifact } = d.registry.publish({
    ingested,
    title: values.title,
    slug: values.slug,
    updateExisting: values.update,
    tags: values.tag ?? [],
    sourceType: "path",
    sourceLabel: target,
    context: captureContext({ type: "path", path: target }),
  });
  console.log(publicationWithUrls(publication, baseUrl).previewUrl);
  console.log(`raw: ${artifactWithUrls(artifact, baseUrl).rawUrl}`);
  d.registry.close();
} else if (cmd === "list") {
  const config = loadConfig();
  const d = deps(config);
  const baseUrl = resolveBaseUrl(config);
  const { publications } = d.registry.listPublications({ limit: 200 });
  for (const p of publications) {
    console.log(`${p.slug}\t${p.kind}\t${p.revisions.length} rev\t${baseUrl}/p/${p.slug}`);
  }
  d.registry.close();
} else {
  console.error(USAGE);
  process.exit(cmd === "help" || cmd === "--help" ? 0 : 1);
}

function resolveBaseUrl(config: ReturnType<typeof loadConfig>): string {
  const fromServer = readServerInfo(config.dataDir)?.baseUrl ?? config.baseUrl;
  if (fromServer) return fromServer;
  console.error("[serve-mcp] no running shelf detected — URLs are relative; start one with `serve-mcp serve`");
  return "";
}
