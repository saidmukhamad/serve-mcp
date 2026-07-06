import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArtifactStore } from "../src/store.ts";
import { Registry } from "../src/registry.ts";
import { loadConfig } from "../src/config.ts";

let portCounter = 17400 + (process.pid % 100);

export function makeDeps({ ephemeral = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "serve-mcp-test-"));
  const config = loadConfig({ dataDir, port: ephemeral ? undefined : portCounter++, host: "127.0.0.1" });
  const store = new ArtifactStore(dataDir);
  const registry = new Registry(dataDir);
  const cleanup = () => {
    registry.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return { store, registry, config, dataDir, cleanup };
}
