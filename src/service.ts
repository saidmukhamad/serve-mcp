import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export interface ServicePaths {
  node: string;
  bin: string;
  logFile: string;
}

const MIN_NODE = 22;

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function launchdPlist({ node, bin, logFile }: ServicePaths): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>serve-mcp</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(bin)}</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>
</dict>
</plist>
`;
}

export function systemdUnit({ node, bin }: ServicePaths): string {
  return `[Unit]
Description=serve-mcp artifact shelf

[Service]
ExecStart="${node}" "${bin}" serve
Restart=on-failure

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
  const paths = { node: process.execPath, bin, logFile: path.join(dataDir, "serve.log") };
  for (const w of runtimeWarnings(paths)) console.error(`[serve-mcp] warning: ${w}`);
  return paths;
}

function run(cmd: string, args: string[], ignoreFailure = false): void {
  try {
    execFileSync(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
  } catch (err) {
    if (!ignoreFailure) throw err;
  }
}

function plistPath(): string {
  return path.join(os.homedir(), "Library/LaunchAgents/serve-mcp.plist");
}

function unitPath(): string {
  return path.join(os.homedir(), ".config/systemd/user/serve-mcp.service");
}

export function installService(dataDir: string): string {
  const paths = servicePaths(dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  if (process.platform === "darwin") {
    const plist = plistPath();
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    run("launchctl", ["unload", "-w", plist], true);
    fs.writeFileSync(plist, launchdPlist(paths));
    run("launchctl", ["load", "-w", plist]);
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
    run("launchctl", ["kickstart", "-k", `gui/${process.getuid!()}/serve-mcp`]);
    return "restarted";
  }
  if (process.platform === "linux") {
    run("systemctl", ["--user", "restart", "serve-mcp"]);
    return "restarted";
  }
  throw new Error(`service restart not supported on ${process.platform}`);
}

export function uninstallService(): string {
  if (process.platform === "darwin") {
    const plist = plistPath();
    run("launchctl", ["unload", "-w", plist], true);
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
