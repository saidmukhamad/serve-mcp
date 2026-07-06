import { Hono, type Context } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectMime, FOLDER_INDEXES } from "./kinds.ts";
import { advertiseHost, baseUrlOf } from "./config.ts";
import { isCgnat, resolveTailnetDnsName } from "./tailnet.ts";
import { writeServerInfo } from "./server-info.ts";
import { artifactWithUrls, publicationWithUrls, type Registry } from "./registry.ts";
import type { ArtifactStore } from "./store.ts";
import type { Artifact, Config, Publication, SourceContext } from "./types.ts";
import {
  renderArtifact,
  renderMarkdown,
  renderCsv,
  renderJson,
  cspFor,
  sandboxFor,
  escapeHtml,
  docShell,
  htmlDoc,
  FRAME_CSP,
} from "./render.ts";
import { StreamableHTTPTransport } from "@hono/mcp";
import { createMcpServer, type Deps } from "./mcp.ts";

export type { Deps };

const SHELL_CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-src 'self'; connect-src 'self'";

function send(c: Context, body: string | Buffer, contentType: string) {
  c.header("Content-Type", contentType);
  return typeof body === "string" ? c.body(body) : c.body(body as Uint8Array<ArrayBuffer>);
}

export function createApp({ registry, store, config }: Deps): Hono {
  const app = new Hono();
  const base = () => baseUrlOf(config);

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
  });

  app.get("/", (c) => {
    const q = c.req.query("q") || undefined;
    const { publications } = registry.listPublications({ query: q, limit: 200 });
    c.header("Content-Security-Policy", SHELL_CSP);
    return c.html(galleryPage(publications, q));
  });

  app.get("/p/:slug", (c) => {
    const pub = registry.getPublication(c.req.param("slug"));
    if (!pub) return c.text("publication not found", 404);
    const artifact = registry.getArtifact(pub.latestArtifactId)!;
    c.header("Content-Security-Policy", SHELL_CSP);
    return c.html(shellPage(pub, artifact, base()));
  });

  app.get("/p/:slug/r/:artifactId", (c) => {
    const pub = registry.getPublication(c.req.param("slug"));
    const artifact = registry.getArtifact(c.req.param("artifactId"));
    if (!pub || !artifact || artifact.publicationId !== pub.id) return c.text("revision not found", 404);
    c.header("Content-Security-Policy", SHELL_CSP);
    return c.html(shellPage(pub, artifact, base(), true));
  });

  app.get("/frame/:artifactId", async (c) => {
    const artifact = registry.getArtifact(c.req.param("artifactId"));
    if (!artifact) return c.text("artifact not found", 404);
    if (artifact.kind === "static-folder") return c.redirect(`/frame/${artifact.id}/`);
    const raw = store.readSource(artifact.id, artifact.filename);
    const { body, contentType } = await renderArtifact(artifact, raw);
    c.header("Content-Security-Policy", cspFor(artifact));
    return send(c, body, contentType);
  });

  app.get("/frame/:artifactId/*", async (c) => {
    const artifact = registry.getArtifact(c.req.param("artifactId"));
    if (!artifact || artifact.kind !== "static-folder") return c.text("not found", 404);
    const rel = decodeURIComponent(c.req.path.split("/").slice(3).join("/"));
    const entry = store.statFolderPath(artifact.id, rel === "" ? "." : rel);
    if (!entry) return c.text("not found", 404);
    c.header("Content-Security-Policy", cspFor(artifact));

    if (entry.type === "dir") {
      if (rel !== "" && !rel.endsWith("/")) return c.redirect(`${c.req.path}/`);
      for (const index of FOLDER_INDEXES) {
        const candidate = path.join(entry.abs, index);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return serveFolderFile(c, candidate);
        }
      }
      const { body, contentType } = docShell(
        artifact.title,
        listingHtml(rel, store.listFolder(artifact.id, rel === "" ? "." : rel))
      );
      return send(c, body, contentType);
    }
    return serveFolderFile(c, entry.abs);
  });

  async function serveFolderFile(c: Context, abs: string) {
    const name = path.basename(abs);
    const wantsRaw = c.req.query("raw") !== undefined;
    const rendered = wantsRaw
      ? null
      : /\.(md|markdown)$/i.test(name)
        ? await renderMarkdown(fs.readFileSync(abs, "utf8"))
        : /\.csv$/i.test(name)
          ? renderCsv(fs.readFileSync(abs, "utf8"), name)
          : /\.json$/i.test(name)
            ? renderJson(fs.readFileSync(abs, "utf8"), name)
            : null;
    if (rendered) {
      const withRawLink = rendered.body.replace(
        "</body>",
        `<p class="muted" style="text-align:center"><a href="?raw" download>download ${escapeHtml(name)}</a></p></body>`
      );
      return send(c, withRawLink, rendered.contentType);
    }
    if (wantsRaw) c.header("Content-Disposition", `attachment; filename="${name.replace(/[^\w.\-]/g, "_")}"`);
    return send(c, fs.readFileSync(abs), detectMime(name));
  }

  app.get("/raw/:artifactId", (c) => {
    const artifact = registry.getArtifact(c.req.param("artifactId"));
    if (!artifact) return c.text("artifact not found", 404);
    if (artifact.kind === "static-folder" && artifact.filename === "files") {
      return c.redirect(`/frame/${artifact.id}/`);
    }
    const raw = store.readSource(artifact.id, artifact.filename);
    c.header("Content-Security-Policy", FRAME_CSP);
    const mime = artifact.mimeType === "text/html" ? "text/plain; charset=utf-8" : artifact.mimeType;
    return send(c, raw, mime);
  });

  app.on("GET", ["/meta/:id", "/api/artifacts/:id"], (c) => {
    const artifact = registry.getArtifact(c.req.param("id"));
    if (!artifact) return c.json({ error: "artifact not found" }, 404);
    return c.json(artifactWithUrls(artifact, base()));
  });

  app.get("/api/publications", (c) => {
    const { publications, nextCursor } = registry.listPublications({
      query: c.req.query("q") || undefined,
      limit: Number(c.req.query("limit") ?? 50),
      cursor: c.req.query("cursor") || undefined,
    });
    return c.json({
      publications: publications.map((p) => publicationWithUrls(p, base())),
      nextCursor,
    });
  });

  app.get("/healthz", (c) => c.json({ ok: true, name: "serve-mcp" }));

  // MCP over HTTP: lets other machines add this shelf as an MCP server
  // (claude mcp add --transport http shelf <baseUrl>/mcp). Stateless — one
  // transport per request.
  app.all("/mcp", async (c) => {
    const transport = new StreamableHTTPTransport({ sessionIdGenerator: undefined });
    const mcp = createMcpServer({ registry, store, config });
    await mcp.connect(transport);
    return (await transport.handleRequest(c)) ?? c.body(null, 406);
  });

  return app;
}

// Binds config.port, or an ephemeral port when null. Resolves to null only
// when an explicit port is taken — another serve-mcp is serving the shelf.
export function startHttp(deps: Deps): Promise<{ server: ServerType; baseUrl: string } | null> {
  const { config } = deps;
  const app = createApp(deps);
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port ?? 0 }, (addr) => {
      void (async () => {
        let host = advertiseHost(config.host);
        // A tailnet IP usually has a MagicDNS name — advertise that instead.
        if (!config.baseUrlExplicit && isCgnat(host)) host = (await resolveTailnetDnsName(host)) ?? host;
        const baseUrl = config.baseUrlExplicit ? config.baseUrl! : `http://${host}:${addr.port}`;
        config.baseUrl = baseUrl;
        writeServerInfo(config.dataDir, { baseUrl, host: config.host, port: addr.port });
        resolve({ server, baseUrl });
      })().catch(reject);
    });
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") resolve(null);
      else reject(err);
    });
  });
}

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
  .card { display: flex; align-items: stretch; gap: 0.8rem; padding: 0.85rem 1rem; margin-top: 0.7rem;
          background: light-dark(#ffffff, #17171c); border: 1px solid light-dark(#e4e4ea, #26262e); border-radius: 10px; }
  .card .title { font-weight: 600; }
  .card .desc { font-size: 0.85rem; color: light-dark(#666670, #9a9aa4); }
  .card .side { display: flex; flex-direction: column; align-items: flex-end; justify-content: space-between;
                gap: 0.45rem; margin-left: auto; flex-shrink: 0; }
  .card .actions { display: flex; align-items: center; gap: 0.8rem; }
  .tag { font-size: 0.72rem; color: light-dark(#0b62d6, #7ab8ff); }
  .branch { color: light-dark(#2da44e, #57d364); }
  h2.section { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.06em;
               color: light-dark(#8a8a94, #77777f); margin: 1.6rem 0 0.2rem; }
  body.shell { display: flex; flex-direction: column; height: 100vh; }
  iframe.preview { display: block; width: 100%; flex: 1; border: 0;
                   background: light-dark(#fff, #16161a); }
  .subbar { display: flex; flex-wrap: wrap; gap: 0.6rem; padding: 0.4rem 1.1rem; font-size: 0.82rem;
            color: light-dark(#777782, #8b8b96); background: light-dark(#ffffff, #17171c);
            border-bottom: 1px solid light-dark(#e4e4ea, #26262e); }
  code { background: light-dark(#f0f0f3, #26262e); padding: 0.05em 0.35em; border-radius: 4px;
         font: 0.92em ui-monospace, SFMono-Regular, Menlo, monospace; }
  .prov { font-size: 0.78rem; color: light-dark(#8a8a94, #77777f); }
  .empty { text-align: center; padding: 4rem 0; }
`;

function page(title: string, body: string, bodyAttrs = ""): string {
  return htmlDoc(title, UI_CSS, body, bodyAttrs);
}

function tildify(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/** git@github.com:user/repo.git and https URLs both display as github.com/user/repo */
function shortRemote(url: string): string {
  return url
    .replace(/^\w+:\/\//, "")
    .replace(/^git@/, "")
    .replace(":", "/")
    .replace(/\.git$/, "");
}

// fish-prompt style: ~/code/serve-mcp/ (main) · github.com/user/repo
function provenanceBits(context: SourceContext | undefined): string[] {
  if (!context) return [];
  const bits: string[] = [];
  const raw = context.path ?? context.cwd;
  const branch = context.git?.branch
    ? ` <span class="branch">(${escapeHtml(context.git.branch)})</span>`
    : "";
  if (raw) {
    const isFile = /\.[^/.]+$/.test(path.basename(raw));
    const dir = tildify(isFile ? path.dirname(raw) : raw).replace(/\/?$/, "/");
    bits.push(`<code>${escapeHtml(dir)}</code>${branch}`);
  } else if (branch) {
    bits.push(branch.trim());
  }
  if (context.git?.remote) {
    const short = shortRemote(context.git.remote);
    bits.push(`<a href="https://${escapeHtml(short)}" target="_blank" rel="noopener">${escapeHtml(short)}</a>`);
  }
  return bits;
}

function relTime(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function listingHtml(rel: string, entries: { name: string; isDir: boolean; sizeBytes: number }[]): string {
  const up = rel === "" || rel === "/" ? "" : `<li><a href="../">../</a></li>`;
  const items = entries
    .map((e) => {
      const href = encodeURIComponent(e.name) + (e.isDir ? "/" : "");
      const size = e.isDir ? "" : `<span class="size">${formatSize(e.sizeBytes)}</span>`;
      return `<li>${size}<a href="${href}">${escapeHtml(e.name)}${e.isDir ? "/" : ""}</a></li>`;
    })
    .join("\n");
  return `<ul class="listing">${up}${items}</ul>`;
}

function galleryPage(pubs: Publication[], q?: string): string {
  const pinned = pubs.filter((p) => p.pinned);
  const rest = pubs.filter((p) => !p.pinned);
  const card = (p: Publication) => `
    <div class="card">
      <div style="min-width:0">
        <a class="title" href="/p/${escapeHtml(p.slug)}">${escapeHtml(p.title)}</a>
        ${p.description ? `<div class="desc">${escapeHtml(p.description)}</div>` : ""}
        ${provenanceBits(p.context).length ? `<div class="prov">${provenanceBits(p.context).join(" · ")}</div>` : ""}
      </div>
      <div class="side">
        <div class="tags">${p.tags.map((t) => `<span class="tag">#${escapeHtml(t)}</span>`).join(" ")}</div>
        <div class="actions">
          <span class="badge">${escapeHtml(p.kind ?? "")}</span>
          <span class="muted">${p.revisions.length} rev · ${relTime(p.updatedAt)}</span>
          <a class="btn" href="/p/${escapeHtml(p.slug)}">Open</a>
          <a class="btn" href="/raw/${escapeHtml(p.latestArtifactId)}">Raw</a>
        </div>
      </div>
    </div>`;
  const section = (label: string, items: Publication[]) =>
    items.length ? `<h2 class="section">${label}</h2>${items.map(card).join("\n")}` : "";
  const body = `
  <header class="bar"><h1>serve-mcp · artifact shelf</h1><div class="spacer"></div>
    <span class="muted">${pubs.length} publication${pubs.length === 1 ? "" : "s"}</span></header>
  <main class="gallery">
    <form class="search" method="get" action="/"><input name="q" placeholder="Search artifacts…" value="${escapeHtml(q ?? "")}"></form>
    ${pubs.length === 0 ? `<div class="empty muted">Nothing published yet. Agents publish with the <code>artifact_publish</code> MCP tool.</div>` : ""}
    ${pinned.length ? section("Pinned", pinned) + section("Recent", rest) : rest.map(card).join("\n")}
  </main>`;
  return page("serve-mcp · artifact shelf", body);
}

function shellPage(pub: Publication, artifact: Artifact, baseUrl: string, isRevision = false): string {
  const frameSrc =
    artifact.kind === "static-folder" ? `/frame/${artifact.id}/` : `/frame/${artifact.id}`;
  const revNote = isRevision
    ? `<span class="badge">revision ${pub.revisions.indexOf(artifact.id) + 1}/${pub.revisions.length}</span>`
    : "";
  const revLinks = pub.revisions
    .map((id, i) => `<a href="/p/${escapeHtml(pub.slug)}/r/${escapeHtml(id)}">r${i + 1}</a>`)
    .join(" · ");
  const subBits = [
    pub.description ? escapeHtml(pub.description) : "",
    ...provenanceBits(artifact.context),
  ].filter(Boolean);
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
  ${subBits.length ? `<div class="subbar">${subBits.join(" · ")}</div>` : ""}
  <iframe class="preview" sandbox="${sandboxFor(artifact)}" src="${frameSrc}"></iframe>`;
  return page(pub.title, body, 'class="shell"');
}
