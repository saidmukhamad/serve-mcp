import fs from "node:fs";
import path from "node:path";

export interface ServerInfo {
  baseUrl: string;
  host: string;
  port: number;
  pid: number;
  startedAt: string;
}

function infoPath(dataDir: string): string {
  return path.join(dataDir, "server.json");
}

export function writeServerInfo(dataDir: string, info: Omit<ServerInfo, "pid" | "startedAt">): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const full: ServerInfo = { ...info, pid: process.pid, startedAt: new Date().toISOString() };
  fs.writeFileSync(infoPath(dataDir), JSON.stringify(full, null, 2));
}

export function readServerInfo(dataDir: string): ServerInfo | null {
  try {
    const info = JSON.parse(fs.readFileSync(infoPath(dataDir), "utf8")) as ServerInfo;
    if (!info.baseUrl || !info.pid) return null;
    process.kill(info.pid, 0);
    return info;
  } catch {
    return null;
  }
}

function lockPath(dataDir: string): string {
  return path.join(dataDir, "server.lock");
}

/**
 * At-most-one-server guard for the ephemeral-port path (a fixed port has the OS
 * bind as its lock). Winner starts the server; losers wait for its server.json.
 */
export function acquireStartLock(dataDir: string): boolean {
  fs.mkdirSync(dataDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockPath(dataDir), String(process.pid), { flag: "wx" });
      return true;
    } catch {
      try {
        const holder = Number(fs.readFileSync(lockPath(dataDir), "utf8"));
        if (holder === process.pid) return true;
        process.kill(holder, 0);
        return false;
      } catch {
        fs.rmSync(lockPath(dataDir), { force: true });
      }
    }
  }
  return false;
}

export function releaseStartLock(dataDir: string): void {
  try {
    if (Number(fs.readFileSync(lockPath(dataDir), "utf8")) === process.pid) {
      fs.rmSync(lockPath(dataDir), { force: true });
    }
  } catch {}
}

export async function waitForServerInfo(dataDir: string, timeoutMs = 5000): Promise<ServerInfo | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = readServerInfo(dataDir);
    if (info) return info;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}
