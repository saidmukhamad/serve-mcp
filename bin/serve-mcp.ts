#!/usr/bin/env node
import "../src/quiet.ts";
import fs from "node:fs";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, configFilePath, setConfigValue, CONFIG_KEYS, type ConfigKey } from "../src/config.ts";
import { ArtifactStore } from "../src/store.ts";
import { Registry, artifactWithUrls, publicationWithUrls } from "../src/registry.ts";
import { startHttp, type Deps } from "../src/http.ts";
import { createMcpServer, packageVersion } from "../src/mcp.ts";
import { acquireStartLock, readServerInfo, releaseStartLock, waitForServerInfo } from "../src/server-info.ts";
import {
  installService,
  restartService,
  serviceInstalled,
  serviceLogs,
  serviceStatus,
  startService,
  stopService,
  uninstallService,
} from "../src/service.ts";
import { captureContext } from "../src/provenance.ts";

const USAGE = `serve-mcp — local MCP-controlled artifact shelf

Usage:
  serve-mcp                                   show shelf status and publications
  serve-mcp <path> [opts]                     publish a file/folder and print its URL
                                              ("serve-mcp ." serves this directory, live)
  serve-mcp config [<key> [<value>]]          show or set config (host, port, baseUrl, stripScripts)
  serve-mcp restart                           restart the shelf / apply config changes
                                              (alias: apply)
  serve-mcp serve [--port <p>] [--host <h>]   run the HTTP preview server
  serve-mcp publish <path> [opts]             publish a file/folder from the CLI
  serve-mcp list                              list publications
  serve-mcp service <action>                  always-on shelf: install, start, stop,
                                              restart, status, logs, uninstall
                                              (launchd / systemd --user / Task Scheduler)
  serve-mcp mcp [--port <p>] [--host <h>]     run MCP server on stdio (for MCP clients)

Examples:
  serve-mcp config host 0.0.0.0    reachable over LAN/Tailscale
  serve-mcp config port 7331       fixed port (empty value unsets a key)

Without a configured port an ephemeral one is used and recorded in the data
dir, so other serve-mcp processes find the running shelf automatically.

Publish options:
  --title <t>   --slug <s>   --update   --tag <t> (repeatable)
  --snapshot    freeze an immutable copy; default serves live from the source path

Env:
  SERVE_MCP_HOST (127.0.0.1)  SERVE_MCP_PORT (ephemeral)
  SERVE_MCP_DATA_DIR (~/.local/share/serve-mcp)
  SERVE_MCP_BASE_URL (advertised URL override)
  SERVE_MCP_ALLOWED_ROOTS (colon-separated publish roots)
  SERVE_MCP_STRIP_SCRIPTS (false; set true to disable HTML/folder scripts)
`;

let [cmdArg, ...rest] = process.argv.slice(2);
let cmd = cmdArg ?? (process.stdin.isTTY ? "status" : "mcp");
const COMMANDS = new Set([
  "mcp", "serve", "publish", "list", "status", "service", "config",
  "restart", "apply", "version", "--version", "-v", "help", "--help",
]);
// `serve-mcp ./report.md` / `serve-mcp .` — a bare path publishes it.
if (cmdArg && !COMMANDS.has(cmdArg) && fs.existsSync(cmdArg)) {
  rest = [cmdArg, ...rest];
  cmd = "publish";
}

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

switch (cmd) {
  case "mcp": {
    const config = loadConfig(serverFlags(rest));
    const d = deps(config);
    // Fixed port: the OS bind is the only-one-server lock. Ephemeral: server.json
    // discovery, with a start lock so simultaneous sessions can't each bind a port.
    if (config.port === null) {
      let existing = readServerInfo(config.dataDir);
      if (!existing && !acquireStartLock(config.dataDir)) {
        existing = await waitForServerInfo(config.dataDir);
      }
      if (existing) {
        config.baseUrl = existing.baseUrl;
        console.error(`[serve-mcp] using running shelf at ${existing.baseUrl} (pid ${existing.pid})`);
      } else {
        try {
          const started = await startHttp(d);
          if (started) console.error(`[serve-mcp] shelf at ${started.baseUrl}`);
        } finally {
          releaseStartLock(config.dataDir);
        }
      }
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
    break;
  }

  case "serve": {
    const config = loadConfig(serverFlags(rest));
    if (config.port === null) {
      const existing = readServerInfo(config.dataDir);
      if (existing) {
        console.error(`[serve-mcp] a shelf is already running at ${existing.baseUrl} (pid ${existing.pid})`);
        process.exit(1);
      }
    }
    const started = await startHttp(deps(config));
    if (!started) {
      console.error(`[serve-mcp] port ${config.port} already in use`);
      process.exit(1);
    }
    console.error(`[serve-mcp] shelf at ${started.baseUrl}`);
    break;
  }

  case "publish": {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        title: { type: "string" },
        slug: { type: "string" },
        update: { type: "boolean", default: false },
        live: { type: "boolean", default: true },
        snapshot: { type: "boolean", default: false },
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
    const ingested = d.store.ingest({ type: "path", path: target }, config.allowedRoots, values.live && !values.snapshot);
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
    break;
  }

  case "list": {
    const config = loadConfig();
    const d = deps(config);
    printPublications(d, resolveBaseUrl(config));
    d.registry.close();
    break;
  }

  case "status": {
    const config = loadConfig();
    const info = readServerInfo(config.dataDir);
    if (info) console.log(`shelf: ${info.baseUrl} (pid ${info.pid})`);
    else console.log("shelf: not running — starts with any MCP session, or `serve-mcp serve`");
    console.log(`data:  ${config.dataDir}`);
    console.log("");
    const d = deps(config);
    printPublications(d, info?.baseUrl ?? config.baseUrl ?? "");
    d.registry.close();
    break;
  }

  case "restart":
  case "apply": {
    const config = loadConfig();
    if (serviceInstalled()) {
      console.log(restartService());
      break;
    }
    const info = readServerInfo(config.dataDir);
    if (!info) {
      console.log("shelf: not running — nothing to restart (start with `serve-mcp serve` or an MCP session)");
      break;
    }
    process.kill(info.pid, "SIGTERM");
    console.log(
      `stopped shelf (pid ${info.pid}) — it was not service-managed; ` +
        "whatever started it must start it again (the next MCP session will, `serve-mcp serve` needs a rerun)"
    );
    break;
  }

  case "service": {
    const config = loadConfig();
    try {
      switch (rest[0]) {
        case "install":
          if (config.port === null) {
            console.error(
              "[serve-mcp] tip: set a fixed port first (`serve-mcp config port 7331`) so URLs survive restarts"
            );
          }
          console.log(installService(config.dataDir));
          break;
        case "start":
          console.log(startService());
          break;
        case "stop":
          console.log(stopService());
          break;
        case "restart":
          console.log(restartService());
          break;
        case "status":
        case undefined:
          console.log(serviceStatus());
          break;
        case "logs":
          console.log(serviceLogs(config.dataDir));
          break;
        case "uninstall":
          console.log(uninstallService(config.dataDir));
          break;
        default:
          console.error("usage: serve-mcp service install|start|stop|restart|status|logs|uninstall");
          process.exit(1);
      }
    } catch (err) {
      console.error(`[serve-mcp] ${(err as Error).message}`);
      process.exit(1);
    }
    break;
  }

  case "config": {
    const config = loadConfig();
    const [key, value] = rest;
    if (key !== undefined && !(CONFIG_KEYS as readonly string[]).includes(key)) {
      console.error(`unknown key: ${key} (valid: ${CONFIG_KEYS.join(", ")})`);
      process.exit(1);
    }
    if (key !== undefined && value !== undefined) {
      const file = setConfigValue(config.dataDir, key as ConfigKey, value);
      console.log(JSON.stringify(file, null, 2).trim());
      console.log(`written to ${configFilePath(config.dataDir)} — apply with \`serve-mcp restart\``);
    } else {
      const effective: Record<ConfigKey, string> = {
        host: config.host,
        port: config.port === null ? "(ephemeral)" : String(config.port),
        baseUrl: config.baseUrl ?? "(auto)",
        stripScripts: String(config.stripScripts),
      };
      if (key !== undefined) {
        console.log(effective[key as ConfigKey]);
      } else {
        console.log(`file: ${configFilePath(config.dataDir)}`);
        for (const k of CONFIG_KEYS) console.log(`${k} = ${effective[k]}`);
      }
    }
    break;
  }

  case "version":
  case "--version":
  case "-v":
    console.log(packageVersion());
    break;

  default:
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
