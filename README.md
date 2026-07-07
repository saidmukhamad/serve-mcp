# serve-mcp

A local, MCP-controlled **artifact shelf**. Your AI agents publish the HTML, Markdown, folders, CSV, and JSON they generate; you get stable, safely-rendered browser URLs to look at them. Built for a machine running several agents at once: each agent gets its own MCP process, and they all publish to one shared shelf.

![The shelf gallery — cards with git provenance, tags, and a per-item menu](https://raw.githubusercontent.com/saidmukhamad/serve-mcp/main/docs/gallery.png)

![A rendered markdown report with a provenance subbar](https://raw.githubusercontent.com/saidmukhamad/serve-mcp/main/docs/preview-markdown.png)

## Quickstart

```bash
npm install -g @saidmukhamad/serve-mcp
```

Add it to Claude Code (it speaks MCP on stdio **and** serves the HTTP shelf):

```bash
claude mcp add serve-mcp -- npx -y @saidmukhamad/serve-mcp mcp
```

That's it. Ask an agent to publish something and open the URL it returns.

## How it works

```txt
MCP = control plane        (artifact_publish, artifact_list, resources)
HTTP = human preview plane (gallery, /p/:slug, sandboxed previews)
Registry = SQLite          (stable publications -> immutable revisions)
Store = snapshots          (nothing is served live from your workspace)
```

## The tools

### `artifact_publish`

```jsonc
{
  "source": { "type": "path", "path": "./report.md" },   // or content / folder
  "title": "Training run explanation",
  "slug": "training-run-explanation",                     // stable /p/<slug>; generated if omitted
  "updateExisting": true,                                 // add a revision; false = conflict on an existing slug
  "tags": ["ml", "report"],
  "renderer": { "options": { "allowScripts": false } }    // scripts stay off unless asked
}
```

Returns the preview URL, a raw URL, an MCP `resource_link`, and structured `artifact`/`publication` objects. Publications are stable slots; every publish is an immutable revision at `/p/:slug/r/:artifactId`.

### `artifact_list`

Filter by `query`, `tags`, `kind`; paginate with `cursor`; order by `createdAt | updatedAt | title`.

### `artifact_delete`

Remove a publication by `slug` — all revisions and stored files go with it. Irreversible.

### Resources

Only `registry://publications` (JSON list of everything on the shelf) appears in `resources/list`, so host UIs stay clean no matter how many publications exist. Two more resolve when read directly (tool results link to them): `publication://<slug>` (compact JSON) and `artifact://<id>` (raw source of a revision).

## Multi-agent port discovery

N agents, one shelf, no coordination. The first `serve-mcp` to start binds a port (`--port`/`SERVE_MCP_PORT`, else ephemeral) and records its reachable URL in `<dataDir>/server.json`; every other serve-mcp process — agents, the CLI — finds that record, checks the pid is alive, and publishes into the running shelf instead of starting its own.

## Rendering & safety

Sources are **snapshotted** into the store (`~/.local/share/serve-mcp`), so nothing is served from your workspace and revisions never change. Markdown/MDX renders through [Sätteri](https://satteri.bruits.org) (GFM, frontmatter, live `mermaid` diagrams); JSON pretty-prints; CSV becomes a table; folders serve as static sites.

Mermaid runs client-side but stays inside the security model: the frame's CSP allows only the shelf's own mermaid script via a per-request nonce, so script tags inside the markdown itself still never execute.

Every HTML, Markdown, and SVG preview is served inside a sandboxed iframe with `Content-Security-Policy: script-src 'none'` — agent-generated content **cannot run scripts, phone home, or touch cookies**. Scripts are an explicit per-artifact opt-in (`renderer.options.allowScripts: true`), which loosens the sandbox to `allow-scripts` for that one artifact.

The server binds `127.0.0.1` unless you opt into `0.0.0.0`, and there is no auth — only expose it to networks you trust (a Tailscale tailnet qualifies; the open internet does not). Restrict path publishing with `SERVE_MCP_ALLOWED_ROOTS=/path/a:/path/b`.

### Folder navigation

Folders behave like a classic file server: each directory serves its own `index.html` / `index.md` / `README.md` (or pass `entrypoint`), `dir` redirects to `dir/` so relative and `../` links resolve, and directories without an index get a browsable listing with a `../` entry. In-folder Markdown/CSV/JSON render on the fly, and any file is downloadable with `?raw`.

### Provenance capture

Every publish records where it came from — source directory plus git branch, remote, and commit — read straight from `.git` files (no `git` subprocess, works even without git installed). This shows on the gallery cards and the preview subbar.

## HTTP routes

```txt
GET    /                         gallery (search, pinned, recent)
GET    /p/:slug                  latest revision, rendered
GET    /p/:slug/r/:artifactId    a specific revision
GET    /raw/:artifactId          original source
GET    /meta/:artifactId         artifact metadata JSON
GET    /api/publications         JSON list (query, cursor, limit)
DELETE /api/publications/:slug   remove a publication and all its revisions
```

## Tailscale / LAN access

To reach the shelf from other machines, set the bind host in the shelf's config file (`~/.local/share/serve-mcp/config.json`):

```json
{ "host": "0.0.0.0", "port": 7331 }
```

Advertised URLs then pick the best reachable name automatically: MagicDNS name (learned via reverse DNS through Quad100 and verified with the system resolver, so it's only used when peers can actually resolve it) → Tailscale IP (`100.64.0.0/10`) → first LAN address. Tailnet detection needs no Tailscale tooling — it keys off the interface's CGNAT address and Tailscale's ULA prefix.

## CLI

```bash
serve-mcp serve                                  # HTTP shelf only
serve-mcp publish ./report.md --title "Report"   # publish without an agent
serve-mcp list                                   # (also discovers a running shelf)
```

## Config

`<dataDir>/config.json` (default `~/.local/share/serve-mcp/config.json`), everything optional:

```json
{
  "host": "0.0.0.0",
  "port": 7331,
  "baseUrl": "http://my-machine.tailnet.ts.net:7331",
  "allowedRoots": ["~/projects", "/srv/artifacts"]
}
```

- `host` — bind host, default `127.0.0.1`
- `port` — fixed port; omit for an ephemeral port + discovery via `server.json`
- `baseUrl` — advertised-URL override (e.g. a MagicDNS name)
- `allowedRoots` — restrict where `path`/`folder` publishing may read from (default: anywhere readable)

Env vars (`SERVE_MCP_HOST`, `SERVE_MCP_PORT`, `SERVE_MCP_BASE_URL`, `SERVE_MCP_DATA_DIR`, `SERVE_MCP_ALLOWED_ROOTS`) override the file; `--host`/`--port` flags override both.

## Development

```bash
npm install
npm test          # typecheck + node:test — core, http, mcp round-trip
npm start         # HTTP server
npm run build     # tsc -> dist/
```

Written in TypeScript; dev and tests run `.ts` directly via Node's native type stripping. Requires **Node ≥ 22.18** (type stripping + built-in `node:sqlite`).

MIT.
