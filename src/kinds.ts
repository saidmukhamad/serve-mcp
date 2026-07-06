import type { ArtifactKind } from "./types.ts";

export { KINDS } from "./types.ts";

const EXT_TO_KIND: Record<string, ArtifactKind> = {
  ".md": "markdown",
  ".markdown": "markdown",
  ".mdx": "mdx",
  ".html": "html",
  ".htm": "html",
  ".svg": "svg",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".gif": "image",
  ".webp": "image",
  ".avif": "image",
  ".json": "json",
  ".csv": "csv",
  ".txt": "text",
  ".log": "text",
};

const EXT_TO_MIME: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".mdx": "text/mdx",
  ".html": "text/html",
  ".htm": "text/html",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".json": "application/json",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".xml": "application/xml",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
};

const BINARY_EXTS = [".zip", ".tar", ".gz", ".bin", ".wasm", ".pdf", ".mp4", ".webm", ".woff", ".woff2"];

function extname(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i === -1 ? "" : filename.slice(i).toLowerCase();
}

export function detectKind(filename: string, isFolder = false): ArtifactKind {
  if (isFolder) return "static-folder";
  const kind = EXT_TO_KIND[extname(filename)];
  if (kind) return kind;
  return BINARY_EXTS.includes(extname(filename)) ? "binary" : "text";
}

export function detectMime(filename: string, fallback = "application/octet-stream"): string {
  return EXT_TO_MIME[extname(filename)] ?? fallback;
}

export const FOLDER_INDEXES = ["index.html", "index.htm", "index.md", "README.md", "readme.md", "report.md"];
