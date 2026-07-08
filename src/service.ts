import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const SERVICE_LABEL = "io.github.saidmukhamad.serve-mcp";
const LEGACY_LABELS = ["serve-mcp"];
const WIN_TASK = "serve-mcp";

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

// Scheduler starts wscript (no console window); the vbs waits on the server and
// forwards its exit code so the task's RestartOnFailure acts as KeepAlive.
export function windowsLaunchVbs({ node, bin, logFile }: ServicePaths): string {
  const q = (s: string) => `""${s}""`;
  const inner = `${q(node)} ${q(bin)} serve >> ${q(logFile)} 2>&1`;
  return `Set shell = CreateObject("WScript.Shell")\r\nrc = shell.Run("cmd /c ""${inner}""", 0, True)\r\nWScript.Quit rc\r\n`;
}

export function windowsTaskXml(vbsPath: string, userId: string): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>serve-mcp artifact shelf (https://github.com/saidmukhamad/serve-mcp)</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>"${xml(vbsPath)}"</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

function windowsUserId(): string {
  const { USERDOMAIN, USERNAME } = process.env;
  return USERDOMAIN && USERNAME ? `${USERDOMAIN}\\${USERNAME}` : os.userInfo().username;
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

function isWsl(): boolean {
  try {
    return fs.readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft");
  } catch {
    return false;
  }
}

function removeLegacyDarwin(): void {
  for (const label of LEGACY_LABELS) {
    run("launchctl", ["bootout", gui(label)], true);
    fs.rmSync(plistPath(label), { force: true });
  }
}

function winFiles(dataDir: string): { vbs: string; taskXml: string } {
  return {
    vbs: path.join(dataDir, "serve-mcp-launch.vbs"),
    taskXml: path.join(dataDir, "serve-mcp-task.xml"),
  };
}

export function installService(dataDir: string): string {
  const paths = servicePaths(dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  switch (process.platform) {
    case "darwin": {
      removeLegacyDarwin();
      const plist = plistPath(SERVICE_LABEL);
      fs.mkdirSync(path.dirname(plist), { recursive: true });
      run("launchctl", ["bootout", gui(SERVICE_LABEL)], true);
      fs.writeFileSync(plist, launchdPlist(paths));
      run("launchctl", ["bootstrap", `gui/${process.getuid!()}`, plist]);
      run("launchctl", ["enable", gui(SERVICE_LABEL)], true);
      return `installed launchd agent: ${plist}\nruntime: ${paths.node}\nbin: ${paths.bin}\nlogs: ${paths.logFile}`;
    }
    case "linux": {
      if (isWsl()) {
        console.error(
          "[serve-mcp] warning: WSL detected — systemd user services are often unavailable there; " +
            "if this fails, run `serve-mcp serve` in tmux instead"
        );
      }
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
    case "win32": {
      const { vbs, taskXml } = winFiles(dataDir);
      fs.writeFileSync(vbs, windowsLaunchVbs(paths));
      fs.writeFileSync(taskXml, "\ufeff" + windowsTaskXml(vbs, windowsUserId()), "utf16le");
      run("schtasks", ["/Create", "/TN", WIN_TASK, "/XML", taskXml, "/F"]);
      run("schtasks", ["/Run", "/TN", WIN_TASK], true);
      return `installed scheduled task: ${WIN_TASK} (runs at logon, restarts on failure)\nruntime: ${paths.node}\nbin: ${paths.bin}\nlogs: ${paths.logFile}`;
    }
    default:
      throw new Error(`service install not supported on ${process.platform}`);
  }
}

export function serviceInstalled(): boolean {
  switch (process.platform) {
    case "darwin":
      return fs.existsSync(plistPath(SERVICE_LABEL));
    case "linux":
      return fs.existsSync(unitPath());
    case "win32":
      return run("schtasks", ["/Query", "/TN", WIN_TASK], true) !== "";
    default:
      return false;
  }
}

export function startService(): string {
  switch (process.platform) {
    case "darwin":
      run("launchctl", ["bootstrap", `gui/${process.getuid!()}`, plistPath(SERVICE_LABEL)], true);
      run("launchctl", ["kickstart", gui(SERVICE_LABEL)]);
      return "started";
    case "linux":
      run("systemctl", ["--user", "start", "serve-mcp"]);
      return "started";
    case "win32":
      run("schtasks", ["/Run", "/TN", WIN_TASK]);
      return "started";
    default:
      throw new Error(`service start not supported on ${process.platform}`);
  }
}

export function stopService(): string {
  switch (process.platform) {
    case "darwin":
      // KeepAlive would resurrect a merely-killed process; bootout unloads it until
      // `service start` or the next login.
      run("launchctl", ["bootout", gui(SERVICE_LABEL)]);
      return "stopped — start again with `serve-mcp service start`";
    case "linux":
      run("systemctl", ["--user", "stop", "serve-mcp"]);
      return "stopped — start again with `serve-mcp service start`";
    case "win32":
      run("schtasks", ["/End", "/TN", WIN_TASK]);
      return "stopped — start again with `serve-mcp service start`";
    default:
      throw new Error(`service stop not supported on ${process.platform}`);
  }
}

export function serviceLogs(dataDir: string, lines = 50): string {
  switch (process.platform) {
    case "linux": {
      const out = run("journalctl", ["--user", "-u", "serve-mcp", "-n", String(lines), "--no-pager"], true);
      if (out.trim()) return out.trim();
      return logTail(path.join(dataDir, "serve.log"), lines);
    }
    default:
      return logTail(path.join(dataDir, "serve.log"), lines);
  }
}

function logTail(logFile: string, lines: number): string {
  try {
    const tail = fs.readFileSync(logFile, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
    return tail || "(log is empty)";
  } catch {
    return `(no log at ${logFile})`;
  }
}

export function restartService(): string {
  switch (process.platform) {
    case "darwin":
      run("launchctl", ["kickstart", "-k", gui(SERVICE_LABEL)]);
      return "restarted";
    case "linux":
      run("systemctl", ["--user", "restart", "serve-mcp"]);
      return "restarted";
    case "win32":
      run("schtasks", ["/End", "/TN", WIN_TASK], true);
      run("schtasks", ["/Run", "/TN", WIN_TASK]);
      return "restarted";
    default:
      throw new Error(`service restart not supported on ${process.platform}`);
  }
}

export function serviceStatus(): string {
  switch (process.platform) {
    case "darwin": {
      const out = run("launchctl", ["print", gui(SERVICE_LABEL)], true);
      if (!out) {
        return fs.existsSync(plistPath(SERVICE_LABEL))
          ? "service: stopped — start with `serve-mcp service start`"
          : "service: not installed";
      }
      const state = out.match(/state = (\S+)/)?.[1] ?? "unknown";
      const pid = out.match(/pid = (\d+)/)?.[1];
      return `service: ${state}${pid ? ` (pid ${pid})` : ""}`;
    }
    case "linux": {
      const out = run("systemctl", ["--user", "is-active", "serve-mcp"], true).trim();
      return `service: ${out || "not installed"}`;
    }
    case "win32": {
      const out = run("schtasks", ["/Query", "/TN", WIN_TASK, "/FO", "CSV", "/NH"], true).trim();
      if (!out) return "service: not installed";
      const status = out.split('","').at(-1)?.replace(/"$/, "") ?? "unknown";
      return `service: ${status.toLowerCase()}`;
    }
    default:
      return "service: not supported on this platform";
  }
}

export function uninstallService(dataDir: string): string {
  switch (process.platform) {
    case "darwin": {
      removeLegacyDarwin();
      const plist = plistPath(SERVICE_LABEL);
      run("launchctl", ["bootout", gui(SERVICE_LABEL)], true);
      fs.rmSync(plist, { force: true });
      return `removed ${plist}`;
    }
    case "linux": {
      run("systemctl", ["--user", "disable", "--now", "serve-mcp"], true);
      fs.rmSync(unitPath(), { force: true });
      run("systemctl", ["--user", "daemon-reload"], true);
      return `removed ${unitPath()}`;
    }
    case "win32": {
      const { vbs, taskXml } = winFiles(dataDir);
      run("schtasks", ["/End", "/TN", WIN_TASK], true);
      run("schtasks", ["/Delete", "/TN", WIN_TASK, "/F"], true);
      fs.rmSync(vbs, { force: true });
      fs.rmSync(taskXml, { force: true });
      return `removed scheduled task ${WIN_TASK}`;
    }
    default:
      throw new Error(`service uninstall not supported on ${process.platform}`);
  }
}
