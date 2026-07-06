/**
 * Artifact kind detection: extension -> kind, kind -> mime.
 */

export const KINDS = [
  "markdown",
  "mdx",
  "html",
  "image",
  "svg",
  "json",
  "csv",
  "text",
  "static-folder",
  "binary",
];

const EXT_TO_KIND = {
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

const EXT_TO_MIME = {
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

function extname(filename) {
  const i = filename.lastIndexOf(".");
  return i === -1 ? "" : filename.slice(i).toLowerCase();
}

export function detectKind(filename, isFolder = false) {
  if (isFolder) return "static-folder";
  const kind = EXT_TO_KIND[extname(filename)];
  if (kind) return kind;
  return looksBinary(filename) ? "binary" : "text";
}

function looksBinary(filename) {
  const ext = extname(filename);
  return [".zip", ".tar", ".gz", ".bin", ".wasm", ".pdf", ".mp4", ".webm", ".woff", ".woff2"].includes(ext);
}

export function detectMime(filename, fallback = "application/octet-stream") {
  return EXT_TO_MIME[extname(filename)] ?? fallback;
}

export function mimeForKind(kind, filename = "") {
  switch (kind) {
    case "markdown": return "text/markdown";
    case "mdx": return "text/mdx";
    case "html": return "text/html";
    case "svg": return "image/svg+xml";
    case "json": return "application/json";
    case "csv": return "text/csv";
    case "text": return "text/plain";
    case "static-folder": return "text/html";
    case "image": return detectMime(filename, "image/png");
    default: return detectMime(filename);
  }
}

/** Default entrypoints for static folders, in priority order. */
export const FOLDER_ENTRYPOINTS = ["index.html", "index.htm", "README.md", "readme.md", "report.md"];
