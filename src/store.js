import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { detectKind, detectMime, FOLDER_ENTRYPOINTS } from "./kinds.js";

/**
 * Artifact store: snapshots sources into <dataDir>/artifacts/<id>/.
 * Artifacts are immutable once ingested; the registry references them by id.
 *
 * Layout:
 *   artifacts/art_xxx/<filename>        single-file artifact source
 *   artifacts/art_xxx/files/...         static-folder artifact tree
 */
export class ArtifactStore {
  constructor(dataDir) {
    this.root = path.join(dataDir, "artifacts");
    fs.mkdirSync(this.root, { recursive: true });
  }

  newId(prefix = "art") {
    return `${prefix}_${randomBytes(9).toString("base64url")}`;
  }

  dirFor(artifactId) {
    if (!/^art_[A-Za-z0-9_-]+$/.test(artifactId)) throw new Error(`invalid artifact id: ${artifactId}`);
    return path.join(this.root, artifactId);
  }

  /**
   * Ingest a source into the store. Returns { id, kind, mimeType, sha256, filename, sizeBytes }.
   * source: { type: "content", content, filename?, mimeType? }
   *       | { type: "path", path }
   *       | { type: "folder", path, entrypoint? }
   */
  ingest(source, allowedRoots) {
    const id = this.newId();
    const dir = this.dirFor(id);
    fs.mkdirSync(dir, { recursive: true });
    try {
      if (source.type === "content") return this.#ingestContent(id, dir, source);
      if (source.type === "path") return this.#ingestPath(id, dir, source, allowedRoots);
      if (source.type === "folder") return this.#ingestFolder(id, dir, source, allowedRoots);
      throw new Error(`unknown source type: ${source.type}`);
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw err;
    }
  }

  #ingestContent(id, dir, { content, filename, mimeType }) {
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

  #ingestPath(id, dir, source, allowedRoots) {
    const abs = resolveWithinRoots(source.path, allowedRoots);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) return this.#ingestFolder(id, dir, { ...source, type: "folder" }, allowedRoots);
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

  #ingestFolder(id, dir, source, allowedRoots) {
    const abs = resolveWithinRoots(source.path, allowedRoots);
    if (!fs.statSync(abs).isDirectory()) throw new Error(`not a directory: ${source.path}`);
    const filesDir = path.join(dir, "files");
    fs.cpSync(abs, filesDir, {
      recursive: true,
      dereference: false,
      filter: (src) => !path.basename(src).startsWith(".") && !src.includes(`${path.sep}node_modules${path.sep}`),
    });
    const entrypoint = pickEntrypoint(filesDir, source.entrypoint);
    const hash = hashTree(filesDir);
    return {
      id,
      kind: "static-folder",
      mimeType: "text/html",
      sha256: hash,
      filename: `files/${entrypoint}`,
      sizeBytes: treeSize(filesDir),
    };
  }

  /** Absolute path of the artifact's primary source file. */
  sourcePath(artifactId, filename) {
    const dir = this.dirFor(artifactId);
    const abs = path.resolve(dir, filename);
    if (!abs.startsWith(dir + path.sep)) throw new Error("path escapes artifact dir");
    return abs;
  }

  readSource(artifactId, filename) {
    return fs.readFileSync(this.sourcePath(artifactId, filename));
  }

  /** Resolve a request path inside a static-folder artifact; null if missing/escaping. */
  resolveFolderFile(artifactId, relPath) {
    const base = path.join(this.dirFor(artifactId), "files");
    const abs = path.resolve(base, relPath);
    if (abs !== base && !abs.startsWith(base + path.sep)) return null;
    if (!fs.existsSync(abs)) return null;
    return fs.statSync(abs).isDirectory() ? null : abs;
  }
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function sanitizeFilename(name) {
  const clean = path.basename(name).replace(/[^\w.\-]+/g, "_");
  if (!clean || clean === "." || clean === "..") throw new Error(`invalid filename: ${name}`);
  return clean;
}

/**
 * Resolve a user-supplied path and require it to live under one of the
 * allowed roots. Roots default to cwd + home; agents publish their own output,
 * we just refuse obviously-out-of-bounds paths like /etc.
 */
export function resolveWithinRoots(p, allowedRoots) {
  const abs = path.resolve(fs.realpathSync(path.resolve(p)));
  const roots = (allowedRoots ?? []).map((r) => path.resolve(r));
  if (roots.length === 0) return abs;
  const ok = roots.some((root) => abs === root || abs.startsWith(root + path.sep));
  if (!ok) throw new Error(`path not under allowed roots: ${p}`);
  return abs;
}

function pickEntrypoint(filesDir, requested) {
  if (requested) {
    const abs = path.resolve(filesDir, requested);
    if (!abs.startsWith(filesDir + path.sep)) throw new Error("entrypoint escapes folder");
    if (!fs.existsSync(abs)) throw new Error(`entrypoint not found: ${requested}`);
    return requested;
  }
  for (const candidate of FOLDER_ENTRYPOINTS) {
    if (fs.existsSync(path.join(filesDir, candidate))) return candidate;
  }
  const first = fs.readdirSync(filesDir).find((f) => /\.(html?|md)$/i.test(f));
  if (first) return first;
  throw new Error("no entrypoint found in folder (expected index.html, README.md, or an .html/.md file)");
}

function hashTree(dir) {
  const h = createHash("sha256");
  for (const file of walk(dir).sort()) {
    h.update(path.relative(dir, file));
    h.update(fs.readFileSync(file));
  }
  return h.digest("hex");
}

function treeSize(dir) {
  return walk(dir).reduce((n, f) => n + fs.statSync(f).size, 0);
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.isFile()) out.push(p);
  }
  return out;
}
