import { markdownToHtml } from "satteri";

/**
 * Renderers turn an artifact into the response served at /frame/:id.
 * Safety model: rendered content is ALWAYS embedded via a sandboxed iframe
 * (no scripts by default) and served with a strict CSP, so raw HTML from
 * markdown or html artifacts cannot run scripts or reach anything.
 */

export const FRAME_CSP =
  "default-src 'none'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; media-src 'self'; script-src 'none'";

export const FRAME_CSP_SCRIPTS =
  "default-src 'none'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; media-src 'self'; script-src 'unsafe-inline' 'self'; connect-src 'self'";

export function allowsScripts(artifact) {
  return artifact.renderer?.options?.allowScripts === true;
}

export function cspFor(artifact) {
  return allowsScripts(artifact) ? FRAME_CSP_SCRIPTS : FRAME_CSP;
}

export function sandboxFor(artifact) {
  return allowsScripts(artifact) ? "allow-scripts" : "";
}

/**
 * Render an artifact to { body, contentType }.
 * `raw` is the artifact's source Buffer (single-file artifacts).
 */
export async function renderArtifact(artifact, raw) {
  switch (artifact.kind) {
    case "markdown":
    case "mdx":
      return renderMarkdown(raw.toString("utf8"));
    case "html":
      return { body: raw.toString("utf8"), contentType: "text/html; charset=utf-8" };
    case "svg":
      return { body: raw, contentType: "image/svg+xml" };
    case "image":
      return docShell(
        artifact.title,
        `<div class="center"><img src="/raw/${artifact.id}" alt="${escapeHtml(artifact.title)}"></div>`
      );
    case "json":
      return renderJson(raw.toString("utf8"), artifact.title);
    case "csv":
      return renderCsv(raw.toString("utf8"), artifact.title);
    case "binary":
      return docShell(
        artifact.title,
        `<p class="muted">Binary artifact (${artifact.mimeType}, ${artifact.sizeBytes} bytes) — <a href="/raw/${artifact.id}">download raw</a></p>`
      );
    default:
      return docShell(artifact.title, `<pre>${escapeHtml(raw.toString("utf8"))}</pre>`);
  }
}

export async function renderMarkdown(md) {
  const { html } = await markdownToHtml(md, { gfm: true, frontmatter: true });
  return docShell("", `<article class="prose">${html}</article>`);
}

function renderJson(text, title) {
  let pretty;
  try {
    pretty = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    pretty = text;
  }
  return docShell(title, `<pre>${escapeHtml(pretty)}</pre>`);
}

function renderCsv(text, title) {
  const rows = parseCsv(text);
  if (rows.length === 0) return docShell(title, `<p class="muted">Empty CSV</p>`);
  const [head, ...body] = rows;
  const thead = `<tr>${head.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr>`;
  const tbody = body
    .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`)
    .join("\n");
  return docShell(title, `<table><thead>${thead}</thead><tbody>${tbody}</tbody></table>`);
}

/** Minimal CSV parser with quoted-field support. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const DOC_CSS = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 2rem; font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         background: light-dark(#ffffff, #16161a); color: light-dark(#1a1a1e, #e8e8ec); }
  .prose, pre, table { max-width: 52rem; margin-inline: auto; }
  h1, h2, h3 { line-height: 1.25; }
  a { color: light-dark(#0b62d6, #7ab8ff); }
  pre { background: light-dark(#f5f5f7, #202027); padding: 1rem; border-radius: 8px; overflow-x: auto;
        font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  code { background: light-dark(#f0f0f3, #26262e); padding: 0.1em 0.35em; border-radius: 4px;
         font: 0.9em ui-monospace, SFMono-Regular, Menlo, monospace; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid light-dark(#dcdce2, #33333c); padding: 0.4rem 0.7rem; text-align: left; }
  th { background: light-dark(#f5f5f7, #202027); }
  img { max-width: 100%; }
  blockquote { border-left: 3px solid light-dark(#dcdce2, #44444e); margin-left: 0; padding-left: 1rem;
               color: light-dark(#555560, #a8a8b2); }
  .center { display: grid; place-items: center; min-height: 80vh; }
  .muted { color: light-dark(#777782, #8b8b96); }
  input[type=checkbox] { accent-color: #0b62d6; }
`;

export function docShell(title, bodyHtml) {
  const body = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${title ? `<title>${escapeHtml(title)}</title>` : ""}
<style>${DOC_CSS}</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
  return { body, contentType: "text/html; charset=utf-8" };
}
