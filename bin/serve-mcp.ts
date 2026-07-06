#!/usr/bin/env node
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../src/config.ts";
import { ArtifactStore } from "../src/store.ts";
import { Registry, artifactWithUrls, publicationWithUrls } from "../src/registry.ts";
import { startHttp, type Deps } from "../src/http.ts";
import { createMcpServer } from "../src/mcp.ts";

const USAGE = `serve-mcp — local MCP-controlled artifact shelf

Usage:
  serve-mcp mcp                     run MCP server on stdio (also serves HTTP)
  serve-mcp serve                   run the HTTP preview server only
  serve-mcp publish <path> [opts]   publish a file/folder from the CLI
  serve-mcp list                    list publications

Publish options:
  --title <t>   --slug <s>   --update   --tag <t> (repeatable)

Env:
  SERVE_MCP_HOST (127.0.0.1)  SERVE_MCP_PORT (7331)
  SERVE_MCP_DATA_DIR (~/.local/share/serve-mcp)
  SERVE_MCP_ALLOWED_ROOTS (colon-separated publish roots)
`;

const [cmd = "mcp", ...rest] = process.argv.slice(2);
const config = loadConfig();

function deps(): Deps {
  return { store: new ArtifactStore(config.dataDir), registry: new Registry(config.dataDir), config };
}

if (cmd === "mcp") {
  const d = deps();
  const server = await startHttp(d);
  console.error(
    server
      ? `[serve-mcp] shelf at ${config.baseUrl}`
      : `[serve-mcp] port ${config.port} busy — assuming another serve-mcp is serving ${config.baseUrl}`
  );
  const mcp = createMcpServer(d);
  await mcp.connect(new StdioServerTransport());
} else if (cmd === "serve") {
  const d = deps();
  const server = await startHttp(d);
  if (!server) {
    console.error(`[serve-mcp] port ${config.port} already in use`);
    process.exit(1);
  }
  console.error(`[serve-mcp] shelf at ${config.baseUrl}`);
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
  const d = deps();
  const ingested = d.store.ingest({ type: "path", path: target });
  const { publication, artifact } = d.registry.publish({
    ingested,
    title: values.title,
    slug: values.slug,
    updateExisting: values.update,
    tags: values.tag ?? [],
    sourceType: "path",
    sourceLabel: target,
  });
  console.log(publicationWithUrls(publication, config.baseUrl).previewUrl);
  console.log(`raw: ${artifactWithUrls(artifact, config.baseUrl).rawUrl}`);
  d.registry.close();
} else if (cmd === "list") {
  const d = deps();
  const { publications } = d.registry.listPublications({ limit: 200 });
  for (const p of publications) {
    console.log(`${p.slug}\t${p.kind}\t${p.revisions.length} rev\t${config.baseUrl}/p/${p.slug}`);
  }
  d.registry.close();
} else {
  console.error(USAGE);
  process.exit(cmd === "help" || cmd === "--help" ? 0 : 1);
}
