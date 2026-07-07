import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const SERVICE_LABEL = "io.github.saidmukhamad.serve-mcp";
const LEGACY_LABELS = ["serve-mcp"];

export interface ServicePaths {
  node: string;
  bin: string;
  dataDir: string;
  logFile: string;
}

const MIN_NODE = 22;

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function launchdPlist({ node, bin, dataDir, logFile }: ServicePaths): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(bin)}</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>WorkingDirectory</key><string>${xml(dataDir)}</string>
  <key>StandardOutPath</key><string>${xml(logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>
</dict>
</plist>
`;
}

export function systemdUnit({ node, bin, dataDir }: ServicePaths): string {
  return `[Unit]
Description=serve-mcp artifact shelf
Documentation=https://github.com/saidmukhamad/serve-mcp

[Service]
ExecStart="${node}" "${bin}" serve
WorkingDirectory=${dataDir}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export function runtimeWarnings(paths: ServicePaths, version = process.version): string[] {
  const warnings: string[] = [];
  const major = Number(version.slice(1).split(".")[0]);
  if (!Number.isNaN(major) && major < MIN_NODE) {
    warnings.push(`runtime ${version} is below the required Node ${MIN_NODE} — the service will not start`);
  }
  if (paths.bin.includes("_npx")) {
    warnings.push(
      "running from the npx cache, which npm may prune — install globally " +
        "(npm i -g @saidmukhamad/serve-mcp) and re-run `serve-mcp service install`"
    );
  }
  if (/\/(\.nvm|\.n\b|nvm|fnm|\.volta)\//.test(paths.node) || paths.node.includes("versions/node/")) {
    warnings.push(
      `service pins this exact runtime: ${paths.node} — ` +
        "if a version manager removes it the service breaks; re-run `serve-mcp service install` after upgrades"
    );
  }
  return warnings;
}

function servicePaths(dataDir: string): ServicePaths {
  const bin = fs.realpathSync(process.argv[1]!);
  const paths = { node: process.execPath, bin, dataDir, logFile: path.join(dataDir, "serve.log") };
  for (const w of runtimeWarnings(paths)) console.error(`[serve-mcp] warning: ${w}`);
  return paths;
}

function run(cmd: string, args: string[], ignoreFailure = false): string {
  try {
    return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  } catch (err) {
    if (!ignoreFailure) throw err;
    return "";
  }
}

function gui(label: string): string {
  return `gui/${process.getuid!()}/${label}`;
}

function plistPath(label: string): string {
  return path.join(os.homedir(), "Library/LaunchAgents", `${label}.plist`);
}

function unitPath(): string {
  return path.join(os.homedir(), ".config/systemd/user/serve-mcp.service");
}

function removeLegacyDarwin(): void {
  for (const label of LEGACY_LABELS) {
    run("launchctl", ["bootout", gui(label)], true);
    fs.rmSync(plistPath(label), { force: true });
  }
}

export function installService(dataDir: string): string {
  const paths = servicePaths(dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  if (process.platform === "darwin") {
    removeLegacyDarwin();
    const plist = plistPath(SERVICE_LABEL);
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    run("launchctl", ["bootout", gui(SERVICE_LABEL)], true);
    fs.writeFileSync(plist, launchdPlist(paths));
    run("launchctl", ["bootstrap", `gui/${process.getuid!()}`, plist]);
    run("launchctl", ["enable", gui(SERVICE_LABEL)], true);
    return `installed launchd agent: ${plist}\nruntime: ${paths.node}\nbin: ${paths.bin}\nlogs: ${paths.logFile}`;
  }
  if (process.platform === "linux") {
    const unit = unitPath();
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.writeFileSync(unit, systemdUnit(paths));
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", "--now", "serve-mcp"]);
    return (
      `installed systemd user unit: ${unit}\n` +
      `runtime: ${paths.node}\nbin: ${paths.bin}\n` +
      `logs: journalctl --user -u serve-mcp\n` +
      `to keep it running after logout: loginctl enable-linger ${os.userInfo().username}`
    );
  }
  throw new Error(`service install not supported on ${process.platform}`);
}

export function restartService(): string {
  if (process.platform === "darwin") {
    run("launchctl", ["kickstart", "-k", gui(SERVICE_LABEL)]);
    return "restarted";
  }
  if (process.platform === "linux") {
    run("systemctl", ["--user", "restart", "serve-mcp"]);
    return "restarted";
  }
  throw new Error(`service restart not supported on ${process.platform}`);
}

export function serviceStatus(): string {
  if (process.platform === "darwin") {
    const out = run("launchctl", ["print", gui(SERVICE_LABEL)], true);
    if (!out) return "service: not installed";
    const state = out.match(/state = (\S+)/)?.[1] ?? "unknown";
    const pid = out.match(/pid = (\d+)/)?.[1];
    return `service: ${state}${pid ? ` (pid ${pid})` : ""}`;
  }
  if (process.platform === "linux") {
    const out = run("systemctl", ["--user", "is-active", "serve-mcp"], true).trim();
    return `service: ${out || "not installed"}`;
  }
  return "service: not supported on this platform";
}

export function uninstallService(): string {
  if (process.platform === "darwin") {
    removeLegacyDarwin();
    const plist = plistPath(SERVICE_LABEL);
    run("launchctl", ["bootout", gui(SERVICE_LABEL)], true);
    fs.rmSync(plist, { force: true });
    return `removed ${plist}`;
  }
  if (process.platform === "linux") {
    run("systemctl", ["--user", "disable", "--now", "serve-mcp"], true);
    fs.rmSync(unitPath(), { force: true });
    run("systemctl", ["--user", "daemon-reload"], true);
    return `removed ${unitPath()}`;
  }
  throw new Error(`service uninstall not supported on ${process.platform}`);
}
