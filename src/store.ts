import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { detectKind, detectMime, FOLDER_INDEXES } from "./kinds.ts";
import type { Ingested, Source } from "./types.ts";

export class ArtifactStore {
  readonly root: string;

  constructor(dataDir: string) {
    this.root = path.join(dataDir, "artifacts");
    fs.mkdirSync(this.root, { recursive: true });
  }

  newId(): string {
    return `art_${randomBytes(9).toString("base64url")}`;
  }

  dirFor(artifactId: string): string {
    if (!/^art_[A-Za-z0-9_-]+$/.test(artifactId)) throw new Error(`invalid artifact id: ${artifactId}`);
    return path.join(this.root, artifactId);
  }

  ingest(source: Source, allowedRoots?: string[]): Ingested {
    const id = this.newId();
    const dir = this.dirFor(id);
    fs.mkdirSync(dir, { recursive: true });
    try {
      if (source.type === "content") return this.ingestContent(id, dir, source);
      if (source.type === "path") return this.ingestPath(id, dir, source, allowedRoots);
      return this.ingestFolder(id, dir, source, allowedRoots);
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw err;
    }
  }

  private ingestContent(
    id: string,
    dir: string,
    { content, filename, mimeType }: Extract<Source, { type: "content" }>
  ): Ingested {
    const name = sanitizeFilename(filename ?? "content.txt");
    const buf = Buffer.from(content, "utf8");
    fs.writeFileSync(path.join(dir, name), buf);
    return {
      id,
      kind: detectKind(name),
      mimeType: mimeType ?? detectMime(name, "text/plain"),
      sha256: sha256(buf),
      filename: name,
      sizeBytes: buf.length,
    };
  }

  private ingestPath(
    id: string,
    dir: string,
    source: Extract<Source, { type: "path" }>,
    allowedRoots?: string[]
  ): Ingested {
    const abs = resolveWithinRoots(source.path, allowedRoots);
    if (fs.statSync(abs).isDirectory()) {
      return this.ingestFolder(id, dir, { type: "folder", path: source.path }, allowedRoots);
    }
    const name = sanitizeFilename(path.basename(abs));
    fs.copyFileSync(abs, path.join(dir, name));
    const buf = fs.readFileSync(path.join(dir, name));
    return {
      id,
      kind: detectKind(name),
      mimeType: detectMime(name),
      sha256: sha256(buf),
      filename: name,
      sizeBytes: buf.length,
    };
  }

  private ingestFolder(
    id: string,
    dir: string,
    source: Extract<Source, { type: "folder" }>,
    allowedRoots?: string[]
  ): Ingested {
    const abs = resolveWithinRoots(source.path, allowedRoots);
    if (!fs.statSync(abs).isDirectory()) throw new Error(`not a directory: ${source.path}`);
    const filesDir = path.join(dir, "files");
    fs.cpSync(abs, filesDir, {
      recursive: true,
      dereference: false,
      filter: (src) => !path.basename(src).startsWith(".") && !src.includes(`${path.sep}node_modules${path.sep}`),
    });
    const entrypoint = pickEntrypoint(filesDir, source.entrypoint);
    return {
      id,
      kind: "static-folder",
      mimeType: "text/html",
      sha256: hashTree(filesDir),
      filename: entrypoint ? `files/${entrypoint}` : "files",
      sizeBytes: treeSize(filesDir),
    };
  }

  sourcePath(artifactId: string, filename: string): string {
    const dir = this.dirFor(artifactId);
    const abs = path.resolve(dir, filename);
    if (!abs.startsWith(dir + path.sep)) throw new Error("path escapes artifact dir");
    return abs;
  }

  readSource(artifactId: string, filename: string): Buffer {
    return fs.readFileSync(this.sourcePath(artifactId, filename));
  }

  statFolderPath(artifactId: string, relPath: string): { abs: string; type: "file" | "dir" } | null {
    const base = path.join(this.dirFor(artifactId), "files");
    const abs = path.resolve(base, relPath);
    if (abs !== base && !abs.startsWith(base + path.sep)) return null;
    if (!fs.existsSync(abs)) return null;
    return { abs, type: fs.statSync(abs).isDirectory() ? "dir" : "file" };
  }

  listFolder(artifactId: string, relPath: string): { name: string; isDir: boolean; sizeBytes: number }[] {
    const entry = this.statFolderPath(artifactId, relPath);
    if (entry?.type !== "dir") return [];
    return fs
      .readdirSync(entry.abs, { withFileTypes: true })
      .filter((e) => e.isFile() || e.isDirectory())
      .map((e) => ({
        name: e.name,
        isDir: e.isDirectory(),
        sizeBytes: e.isDirectory() ? 0 : fs.statSync(path.join(entry.abs, e.name)).size,
      }))
      .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
  }
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function sanitizeFilename(name: string): string {
  const clean = path.basename(name).replace(/[^\w.\-]+/g, "_");
  if (!clean || clean === "." || clean === "..") throw new Error(`invalid filename: ${name}`);
  return clean;
}

export function resolveWithinRoots(p: string, allowedRoots?: string[]): string {
  const abs = path.resolve(fs.realpathSync(path.resolve(p)));
  const roots = (allowedRoots ?? []).map((r) => path.resolve(r));
  if (roots.length === 0) return abs;
  const ok = roots.some((root) => abs === root || abs.startsWith(root + path.sep));
  if (!ok) throw new Error(`path not under allowed roots: ${p}`);
  return abs;
}

function pickEntrypoint(filesDir: string, requested?: string): string | null {
  if (requested) {
    const abs = path.resolve(filesDir, requested);
    if (!abs.startsWith(filesDir + path.sep)) throw new Error("entrypoint escapes folder");
    if (!fs.existsSync(abs)) throw new Error(`entrypoint not found: ${requested}`);
    return requested;
  }
  for (const candidate of FOLDER_INDEXES) {
    if (fs.existsSync(path.join(filesDir, candidate))) return candidate;
  }
  const first = fs.readdirSync(filesDir).find((f) => /\.(html?|md)$/i.test(f));
  return first ?? null;
}

function hashTree(dir: string): string {
  const h = createHash("sha256");
  for (const file of walk(dir).sort()) {
    h.update(path.relative(dir, file));
    h.update(fs.readFileSync(file));
  }
  return h.digest("hex");
}

function treeSize(dir: string): number {
  return walk(dir).reduce((n, f) => n + fs.statSync(f).size, 0);
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.isFile()) out.push(p);
  }
  return out;
}
