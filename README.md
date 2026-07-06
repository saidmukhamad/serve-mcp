# serve-mcp

A local MCP-controlled **artifact shelf**. Agents publish generated HTML, Markdown, folders, JSON, CSV, and images; humans get stable, nicely rendered browser URLs. Built for machines running more than one agent: every agent gets its own MCP process, they all share one shelf.

```txt
agent writes ./work.html
agent calls artifact_publish({ source: { type: "path", path: "./work.html" }, title: "Work explanation" })
server returns http://127.0.0.1:7331/p/work-explanation
```

```txt
MCP = control plane        (artifact_publish, artifact_list, resources)
HTTP = human preview plane (gallery, /p/:slug, sandboxed previews)
Registry = SQLite          (publications -> immutable artifact revisions)
Renderer = source -> safe preview
```

## Install

```bash
npm install -g serve-mcp     # or: npx serve-mcp mcp
```

Add to Claude Code:

```bash
claude mcp add shelf -- npx -y serve-mcp mcp
```

The `mcp` command speaks MCP on stdio **and** serves the HTTP shelf. Ports work like this: pass `--port`/`SERVE_MCP_PORT` for a fixed port, otherwise an **ephemeral** port is used. Whoever binds records their URL in `<dataDir>/server.json`, so every other serve-mcp process (other agents, the CLI) discovers the running shelf and publishes into it instead of starting another server — that's the multi-agent story: shared SQLite registry in WAL mode, one process serving, N processes publishing.

To reach the shelf from other machines (e.g. over Tailscale), bind all interfaces:

```bash
serve-mcp serve --host 0.0.0.0 --port 7331
```

`0.0.0.0` is not a linkable address, so advertised URLs pick the best reachable name automatically: the machine's MagicDNS name (learned via reverse DNS and verified through the system resolver, so it's only used when peers can actually resolve it), else the Tailscale IP (100.64.0.0/10), else the first LAN address. `SERVE_MCP_BASE_URL` overrides everything. Detection is pure `os.networkInterfaces()` + standard DNS — no Tailscale CLI or API.

## Model-facing API (deliberately tiny)

### `artifact_publish`

```jsonc
{
  "source": { "type": "path", "path": "./report.md" },      // or content / folder
  "title": "Training run explanation",
  "slug": "training-run-explanation",                        // stable /p/<slug>; generated if omitted
  "updateExisting": true,                                    // add revision; false -> conflict on existing slug
  "tags": ["ml", "report"],
  "renderer": { "options": { "allowScripts": false } }       // scripts stay off unless asked
}
```

Returns the preview URL, raw URL, an MCP `resource_link`, and structured `artifact`/`publication` objects. Publications are stable slots; every publish is an immutable revision (`/p/:slug/r/:artifactId`).

### `artifact_list`

Filter by `query`, `tags`, `kind`; paginate with `cursor`; order by `createdAt|updatedAt|title`.

### Resources

```txt
registry://publications   JSON list of everything on the shelf (the only listed resource)
publication://<slug>      compact JSON (preview/raw URLs, latest revision) — read-only, not enumerated
artifact://<id>           raw source of a revision — read-only, not enumerated
```

Only `registry://publications` shows up in `resources/list`, so host UIs stay clean however many publications exist; the `publication://` and `artifact://` URIs resolve when read directly (tool results include them as resource links).

## Human-facing API

```txt
GET /                       gallery (search, pinned, recent)
GET /p/:slug                latest revision, rendered
GET /p/:slug/r/:artifactId  specific revision
GET /raw/:artifactId        original source
GET /meta/:artifactId       artifact metadata JSON
GET /api/publications       JSON list
```

## Rendering & safety

Sources are **snapshotted** into the store (`~/.local/share/serve-mcp`) — nothing serves from your workspace, and revisions are immutable. Markdown/MDX renders through [Sätteri](https://satteri.bruits.org) (GFM, frontmatter). HTML, Markdown output, and SVG are always served inside a sandboxed iframe with `Content-Security-Policy: script-src 'none'` — agent-generated content cannot run scripts, phone home, or touch cookies. Scripts require an explicit opt-in per artifact (`renderer.options.allowScripts: true`), which loosens the sandbox to `allow-scripts` for that artifact only. The server binds `127.0.0.1` unless you opt into `0.0.0.0`; there is no auth, so only expose it to networks you trust (a Tailscale tailnet qualifies, the open internet does not). Path publishing can be restricted with `SERVE_MCP_ALLOWED_ROOTS=/path/a:/path/b`.

JSON pretty-prints, CSV becomes a table, folders serve as static sites behind the same sandbox. Folder navigation works like a classic file server: each directory serves its own `index.html`/`index.md`/`README.md` (or pass `entrypoint`), `dir` redirects to `dir/` so relative and `../` links resolve, and directories without an index get a browsable listing with a `../` entry. In-folder Markdown renders on the fly, so `.md` files can link to each other across directories.

## CLI

```bash
serve-mcp serve                                  # HTTP shelf only
serve-mcp publish ./report.md --title "Report"   # publish without an agent
serve-mcp list
```

## Config

Environment variables (all optional):

```txt
SERVE_MCP_HOST           bind host, default 127.0.0.1 (0.0.0.0 for LAN/Tailscale)
SERVE_MCP_PORT           fixed port; unset = ephemeral + discovery via server.json
SERVE_MCP_BASE_URL       advertised URL override (e.g. MagicDNS name)
SERVE_MCP_DATA_DIR       default ~/.local/share/serve-mcp
SERVE_MCP_ALLOWED_ROOTS  colon-separated roots for path/folder publishing (default: anywhere readable)
```

`--port` and `--host` flags on `serve`/`mcp` override the env.

## MCP over HTTP (experimental)

The shelf also speaks MCP at `<baseUrl>/mcp` (Streamable HTTP transport, stateless). Combined with `--host 0.0.0.0`, agents on *other* machines can use this shelf directly:

```bash
# on machine B, pointing at machine A's shelf over the tailnet
claude mcp add shelf-a --transport http http://100.x.y.z:7331/mcp
```

Run a shelf on each machine and point them at each other, and publishing works in both directions. Caveat: `path`/`folder` sources are read from the filesystem of the machine *running the shelf* — remote publishers should use `content` sources. Tailnet detection needs no Tailscale tooling.

## Non-goals

Not a CDN, not a deploy platform, not a filesystem browser, not a CMS. It does one thing: **publish generated artifacts → render safely → remember them → list them.**

## Development

```bash
npm install
npm test          # typecheck + node:test — core, http, mcp round-trip
npm start         # HTTP server
npm run build     # tsc -> dist/ (what npm ships)
```

Written in TypeScript; dev and tests run `.ts` directly via Node's native type stripping. Requires Node ≥ 22.18 (type stripping + built-in `node:sqlite`). MIT.
