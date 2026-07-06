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
