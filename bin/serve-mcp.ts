#!/usr/bin/env node
import "../src/quiet.ts";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, configFilePath, setConfigValue, CONFIG_KEYS, type ConfigKey } from "../src/config.ts";
import { ArtifactStore } from "../src/store.ts";
import { Registry, artifactWithUrls, publicationWithUrls } from "../src/registry.ts";
import { startHttp, type Deps } from "../src/http.ts";
import { createMcpServer } from "../src/mcp.ts";
import { readServerInfo } from "../src/server-info.ts";
import { installService, restartService, serviceStatus, uninstallService } from "../src/service.ts";
import { captureContext } from "../src/provenance.ts";

const USAGE = `serve-mcp — local MCP-controlled artifact shelf

Usage:
  serve-mcp                                   show shelf status and publications
  serve-mcp config [<key> [<value>]]          show or set config (host, port, baseUrl)
  serve-mcp serve [--port <p>] [--host <h>]   run the HTTP preview server
  serve-mcp publish <path> [opts]             publish a file/folder from the CLI
  serve-mcp list                              list publications
  serve-mcp service install|status|restart|uninstall
                                              always-on shelf (launchd / systemd --user)
  serve-mcp mcp [--port <p>] [--host <h>]     run MCP server on stdio (for MCP clients)

Examples:
  serve-mcp config host 0.0.0.0    reachable over LAN/Tailscale
  serve-mcp config port 7331       fixed port (empty value unsets a key)

Without a configured port an ephemeral one is used and recorded in the data
dir, so other serve-mcp processes find the running shelf automatically.

Publish options:
  --title <t>   --slug <s>   --update   --tag <t> (repeatable)

Env:
  SERVE_MCP_HOST (127.0.0.1)  SERVE_MCP_PORT (ephemeral)
  SERVE_MCP_DATA_DIR (~/.local/share/serve-mcp)
  SERVE_MCP_BASE_URL (advertised URL override)
  SERVE_MCP_ALLOWED_ROOTS (colon-separated publish roots)
`;

const [cmdArg, ...rest] = process.argv.slice(2);
const cmd = cmdArg ?? (process.stdin.isTTY ? "status" : "mcp");

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
  printPublications(d, resolveBaseUrl(config));
  d.registry.close();
} else if (cmd === "status") {
  const config = loadConfig();
  const info = readServerInfo(config.dataDir);
  if (info) console.log(`shelf: ${info.baseUrl} (pid ${info.pid})`);
  else console.log("shelf: not running — starts with any MCP session, or `serve-mcp serve`");
  console.log(`data:  ${config.dataDir}`);
  console.log("");
  const d = deps(config);
  printPublications(d, info?.baseUrl ?? config.baseUrl ?? "");
  d.registry.close();
} else if (cmd === "service") {
  const config = loadConfig();
  const action = rest[0];
  if (action === "install") {
    if (config.port === null) {
      console.error(
        "[serve-mcp] tip: set a fixed port first (`serve-mcp config port 7331`) so URLs survive restarts"
      );
    }
    console.log(installService(config.dataDir));
  } else if (action === "restart") {
    console.log(restartService());
  } else if (action === "status" || action === undefined) {
    console.log(serviceStatus());
  } else if (action === "uninstall") {
    console.log(uninstallService());
  } else {
    console.error("usage: serve-mcp service install|status|restart|uninstall");
    process.exit(1);
  }
} else if (cmd === "config") {
  const config = loadConfig();
  const [key, value] = rest;
  if (key !== undefined && !(CONFIG_KEYS as readonly string[]).includes(key)) {
    console.error(`unknown key: ${key} (valid: ${CONFIG_KEYS.join(", ")})`);
    process.exit(1);
  }
  if (key !== undefined && value !== undefined) {
    const file = setConfigValue(config.dataDir, key as ConfigKey, value);
    console.log(JSON.stringify(file, null, 2).trim());
    console.log(`written to ${configFilePath(config.dataDir)} — restart the shelf to apply`);
  } else {
    const effective: Record<ConfigKey, string> = {
      host: config.host,
      port: config.port === null ? "(ephemeral)" : String(config.port),
      baseUrl: config.baseUrl ?? "(auto)",
    };
    if (key !== undefined) {
      console.log(effective[key as ConfigKey]);
    } else {
      console.log(`file: ${configFilePath(config.dataDir)}`);
      for (const k of CONFIG_KEYS) console.log(`${k} = ${effective[k]}`);
    }
  }
} else {
  console.error(USAGE);
  process.exit(cmd === "help" || cmd === "--help" ? 0 : 1);
}

function printPublications(d: Deps, baseUrl: string) {
  const { publications } = d.registry.listPublications({ limit: 200 });
  if (publications.length === 0) {
    console.log("(shelf is empty)");
    return;
  }
  for (const p of publications) {
    console.log(`${p.slug}\t${p.kind}\t${p.revisions.length} rev\t${baseUrl}/p/${p.slug}`);
  }
}

function resolveBaseUrl(config: ReturnType<typeof loadConfig>): string {
  const fromServer = readServerInfo(config.dataDir)?.baseUrl ?? config.baseUrl;
  if (fromServer) return fromServer;
  console.error("[serve-mcp] no running shelf detected — URLs are relative; start one with `serve-mcp serve`");
  return "";
}
