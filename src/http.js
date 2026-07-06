import { Hono } from "hono";
import { serve } from "@hono/node-server";
import fs from "node:fs";
import path from "node:path";
import { detectMime } from "./kinds.js";
import { withUrls } from "./registry.js";
import {
  renderArtifact,
  renderMarkdown,
  cspFor,
  sandboxFor,
  escapeHtml,
  FRAME_CSP,
} from "./render.js";

const SHELL_CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-src 'self'; connect-src 'self'";

export function createApp({ registry, store, config }) {
  const app = new Hono();

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
  });

  // ---- gallery ----------------------------------------------------------
  app.get("/", (c) => {
    const q = c.req.query("q") || undefined;
    const { publications } = registry.listPublications({ query: q, limit: 200 });
    c.header("Content-Security-Policy", SHELL_CSP);
    return c.html(galleryPage(publications, q, config.baseUrl));
  });

  // ---- preview shell ----------------------------------------------------
  app.get("/p/:slug", (c) => {
    const pub = registry.getPublication(c.req.param("slug"));
    if (!pub) return c.text("publication not found", 404);
    const artifact = registry.getArtifact(pub.latestArtifactId);
    c.header("Content-Security-Policy", SHELL_CSP);
    return c.html(shellPage(pub, artifact, config.baseUrl));
  });

  app.get("/p/:slug/r/:artifactId", (c) => {
    const pub = registry.getPublication(c.req.param("slug"));
    const artifact = registry.getArtifact(c.req.param("artifactId"));
    if (!pub || !artifact || artifact.publicationId !== pub.id) return c.text("revision not found", 404);
    c.header("Content-Security-Policy", SHELL_CSP);
    return c.html(shellPage(pub, artifact, config.baseUrl, true));
  });

  // ---- rendered frame ---------------------------------------------------
  app.get("/frame/:artifactId", async (c) => {
    const artifact = registry.getArtifact(c.req.param("artifactId"));
    if (!artifact) return c.text("artifact not found", 404);
    if (artifact.kind === "static-folder") return c.redirect(`/frame/${artifact.id}/`);
    const raw = store.readSource(artifact.id, artifact.filename);
    const { body, contentType } = await renderArtifact(artifact, raw);
    c.header("Content-Security-Policy", cspFor(artifact));
    c.header("Content-Type", contentType);
    return c.body(body);
  });

  // static-folder file serving (also renders in-folder markdown entrypoints)
  app.get("/frame/:artifactId/*", async (c) => {
    const artifact = registry.getArtifact(c.req.param("artifactId"));
    if (!artifact || artifact.kind !== "static-folder") return c.text("not found", 404);
    let rel = decodeURIComponent(c.req.path.split("/").slice(3).join("/"));
    if (rel === "" || rel.endsWith("/")) {
      rel += artifact.filename.replace(/^files\//, "");
    }
    const abs = store.resolveFolderFile(artifact.id, rel);
    if (!abs) return c.text("not found", 404);
    c.header("Content-Security-Policy", cspFor(artifact));
    if (/\.(md|markdown)$/i.test(abs)) {
      const { body, contentType } = await renderMarkdown(fs.readFileSync(abs, "utf8"));
      c.header("Content-Type", contentType);
      return c.body(body);
    }
    c.header("Content-Type", detectMime(path.basename(abs)));
    return c.body(fs.readFileSync(abs));
  });

  // ---- raw + meta + api -------------------------------------------------
  app.get("/raw/:artifactId", (c) => {
    const artifact = registry.getArtifact(c.req.param("artifactId"));
    if (!artifact) return c.text("artifact not found", 404);
    const raw = store.readSource(artifact.id, artifact.filename);
    c.header("Content-Security-Policy", FRAME_CSP);
    const mime = artifact.mimeType === "text/html" ? "text/plain; charset=utf-8" : artifact.mimeType;
    c.header("Content-Type", mime);
    return c.body(raw);
  });

  app.get("/meta/:artifactId", (c) => {
    const artifact = registry.getArtifact(c.req.param("artifactId"));
    if (!artifact) return c.json({ error: "artifact not found" }, 404);
    return c.json(withUrls(artifact, config.baseUrl, "artifact"));
  });

  app.get("/api/publications", (c) => {
    const { publications, nextCursor } = registry.listPublications({
      query: c.req.query("q") || undefined,
      limit: Number(c.req.query("limit") ?? 50),
      cursor: c.req.query("cursor") || undefined,
    });
    return c.json({
      publications: publications.map((p) => withUrls(p, config.baseUrl, "publication")),
      nextCursor,
    });
  });

  app.get("/api/artifacts/:id", (c) => {
    const artifact = registry.getArtifact(c.req.param("id"));
    if (!artifact) return c.json({ error: "artifact not found" }, 404);
    return c.json(withUrls(artifact, config.baseUrl, "artifact"));
  });

  app.get("/healthz", (c) => c.json({ ok: true, name: "serve-mcp" }));

  return app;
}

/**
 * Bind the HTTP server. Resolves to the server, or null if the port is
 * already taken — which in the multi-agent case means another serve-mcp
 * process is serving the shared shelf, so we just use its URL.
 */
export function startHttp({ registry, store, config }) {
  const app = createApp({ registry, store, config });
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => resolve(server));
    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") resolve(null);
      else reject(err);
    });
  });
}

// ---- html ----------------------------------------------------------------

const UI_CSS = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         background: light-dark(#f7f7f9, #101014); color: light-dark(#1a1a1e, #e8e8ec); }
  a { color: light-dark(#0b62d6, #7ab8ff); text-decoration: none; }
  header.bar { display: flex; align-items: center; gap: 0.9rem; padding: 0.65rem 1.1rem;
               background: light-dark(#ffffff, #17171c); border-bottom: 1px solid light-dark(#e4e4ea, #26262e);
               position: sticky; top: 0; }
  header.bar h1 { font-size: 1rem; margin: 0; font-weight: 600; }
  .badge { font-size: 0.72rem; padding: 0.1rem 0.5rem; border-radius: 99px; text-transform: uppercase;
           letter-spacing: 0.04em; background: light-dark(#eceff4, #26262e); color: light-dark(#4a4a55, #a8a8b2); }
  .muted { color: light-dark(#777782, #8b8b96); font-size: 0.85rem; }
  .spacer { flex: 1; }
  .btn { font-size: 0.82rem; padding: 0.25rem 0.7rem; border-radius: 6px; border: 1px solid light-dark(#d8d8e0, #33333c);
         background: light-dark(#fff, #1d1d23); color: inherit; cursor: pointer; }
  main.gallery { max-width: 60rem; margin: 0 auto; padding: 1.4rem 1.1rem 4rem; }
  form.search input { width: 100%; padding: 0.55rem 0.9rem; border-radius: 8px; font: inherit;
                      border: 1px solid light-dark(#d8d8e0, #33333c); background: light-dark(#fff, #17171c); color: inherit; }
  .card { display: flex; align-items: center; gap: 0.8rem; padding: 0.85rem 1rem; margin-top: 0.7rem;
          background: light-dark(#ffffff, #17171c); border: 1px solid light-dark(#e4e4ea, #26262e); border-radius: 10px; }
  .card .title { font-weight: 600; }
  .card .desc { font-size: 0.85rem; color: light-dark(#666670, #9a9aa4); }
  .tag { font-size: 0.72rem; color: light-dark(#0b62d6, #7ab8ff); }
  h2.section { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.06em;
               color: light-dark(#8a8a94, #77777f); margin: 1.6rem 0 0.2rem; }
  iframe.preview { display: block; width: 100%; height: calc(100vh - 49px); border: 0;
                   background: light-dark(#fff, #16161a); }
  .empty { text-align: center; padding: 4rem 0; }
`;

function page(title, body) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${UI_CSS}</style>
</head>
<body>
${body}
</body>
</html>`;
}

function relTime(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function galleryPage(pubs, q, baseUrl) {
  const pinned = pubs.filter((p) => p.pinned);
  const rest = pubs.filter((p) => !p.pinned);
  const card = (p) => `
    <div class="card">
      <div style="min-width:0">
        <a class="title" href="/p/${escapeHtml(p.slug)}">${escapeHtml(p.title)}</a>
        ${p.description ? `<div class="desc">${escapeHtml(p.description)}</div>` : ""}
        <div class="muted">${p.tags.map((t) => `<span class="tag">#${escapeHtml(t)}</span>`).join(" ")}</div>
      </div>
      <div class="spacer"></div>
      <span class="badge">${escapeHtml(p.kind ?? "")}</span>
      <span class="muted">${p.revisions.length} rev · ${relTime(p.updatedAt)}</span>
      <a class="btn" href="/p/${escapeHtml(p.slug)}">Open</a>
      <a class="btn" href="/raw/${escapeHtml(p.latestArtifactId)}">Raw</a>
    </div>`;
  const section = (label, items) =>
    items.length ? `<h2 class="section">${label}</h2>${items.map(card).join("\n")}` : "";
  const body = `
  <header class="bar"><h1>serve-mcp · artifact shelf</h1><div class="spacer"></div>
    <span class="muted">${pubs.length} publication${pubs.length === 1 ? "" : "s"}</span></header>
  <main class="gallery">
    <form class="search" method="get" action="/"><input name="q" placeholder="Search artifacts…" value="${escapeHtml(q ?? "")}"></form>
    ${pubs.length === 0 ? `<div class="empty muted">Nothing published yet. Agents publish with the <code>artifact_publish</code> MCP tool.</div>` : ""}
    ${section("Pinned", pinned)}
    ${section(pinned.length ? "Recent" : "", rest) || (pinned.length === 0 ? rest.map(card).join("\n") : "")}
  </main>`;
  return page("serve-mcp · artifact shelf", body);
}

function shellPage(pub, artifact, baseUrl, isRevision = false) {
  const frameSrc =
    artifact.kind === "static-folder" ? `/frame/${artifact.id}/` : `/frame/${artifact.id}`;
  const revNote = isRevision
    ? `<span class="badge">revision ${pub.revisions.indexOf(artifact.id) + 1}/${pub.revisions.length}</span>`
    : "";
  const revLinks = pub.revisions
    .map((id, i) => `<a href="/p/${escapeHtml(pub.slug)}/r/${escapeHtml(id)}">r${i + 1}</a>`)
    .join(" · ");
  const body = `
  <header class="bar">
    <a href="/" title="back to shelf">←</a>
    <h1>${escapeHtml(pub.title)}</h1>
    <span class="badge">${escapeHtml(artifact.kind)}</span>
    ${revNote}
    <span class="muted">${relTime(artifact.createdAt)}</span>
    <div class="spacer"></div>
    ${pub.revisions.length > 1 ? `<span class="muted">${revLinks}</span>` : ""}
    <a class="btn" href="/raw/${escapeHtml(artifact.id)}">Raw</a>
    <button class="btn" onclick="navigator.clipboard.writeText('${escapeHtml(baseUrl)}/p/${escapeHtml(pub.slug)}').then(()=>{this.textContent='Copied';setTimeout(()=>this.textContent='Copy URL',1200)})">Copy URL</button>
  </header>
  <iframe class="preview" sandbox="${sandboxFor(artifact)}" src="${frameSrc}"></iframe>`;
  return page(pub.title, body);
}
