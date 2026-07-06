import type { ArtifactKind } from "./types.ts";

export { KINDS } from "./types.ts";

const EXTENSIONS: Record<string, [ArtifactKind, string]> = {
  ".md": ["markdown", "text/markdown"],
  ".markdown": ["markdown", "text/markdown"],
  ".mdx": ["mdx", "text/mdx"],
  ".html": ["html", "text/html"],
  ".htm": ["html", "text/html"],
  ".svg": ["svg", "image/svg+xml"],
  ".png": ["image", "image/png"],
  ".jpg": ["image", "image/jpeg"],
  ".jpeg": ["image", "image/jpeg"],
  ".gif": ["image", "image/gif"],
  ".webp": ["image", "image/webp"],
  ".avif": ["image", "image/avif"],
  ".ico": ["image", "image/x-icon"],
  ".json": ["json", "application/json"],
  ".csv": ["csv", "text/csv"],
  ".txt": ["text", "text/plain"],
  ".log": ["text", "text/plain"],
  ".css": ["text", "text/css"],
  ".js": ["text", "text/javascript"],
  ".mjs": ["text", "text/javascript"],
  ".xml": ["text", "application/xml"],
  ".pdf": ["binary", "application/pdf"],
  ".mp4": ["binary", "video/mp4"],
  ".webm": ["binary", "video/webm"],
  ".woff": ["binary", "font/woff"],
  ".woff2": ["binary", "font/woff2"],
  ".zip": ["binary", "application/zip"],
  ".tar": ["binary", "application/x-tar"],
  ".gz": ["binary", "application/gzip"],
  ".bin": ["binary", "application/octet-stream"],
  ".wasm": ["binary", "application/wasm"],
};

function extname(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i === -1 ? "" : filename.slice(i).toLowerCase();
}

export function detectKind(filename: string, isFolder = false): ArtifactKind {
  if (isFolder) return "static-folder";
  return EXTENSIONS[extname(filename)]?.[0] ?? "text";
}

export function detectMime(filename: string, fallback = "application/octet-stream"): string {
  return EXTENSIONS[extname(filename)]?.[1] ?? fallback;
}

export const FOLDER_INDEXES = ["index.html", "index.htm", "index.md", "README.md", "readme.md", "report.md"];
