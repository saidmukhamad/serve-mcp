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

The `mcp` command speaks MCP on stdio **and** starts the HTTP shelf on `127.0.0.1:7331`. If the port is already bound, another serve-mcp process (another agent) is serving the shared shelf, and this one just publishes into it — that's the multi-agent story: shared SQLite registry in WAL mode, one process serving, N processes publishing.

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
registry://publications   JSON list of everything on the shelf
publication://<slug>      compact JSON (preview/raw URLs, latest revision)
artifact://<id>           raw source of a revision
```

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

Sources are **snapshotted** into the store (`~/.local/share/serve-mcp`) — nothing serves from your workspace, and revisions are immutable. Markdown/MDX renders through [Sätteri](https://satteri.bruits.org) (GFM, frontmatter). HTML, Markdown output, and SVG are always served inside a sandboxed iframe with `Content-Security-Policy: script-src 'none'` — agent-generated content cannot run scripts, phone home, or touch cookies. Scripts require an explicit opt-in per artifact (`renderer.options.allowScripts: true`), which loosens the sandbox to `allow-scripts` for that artifact only. The server binds `127.0.0.1` only. Path publishing can be restricted with `SERVE_MCP_ALLOWED_ROOTS=/path/a:/path/b`.

JSON pretty-prints, CSV becomes a table, folders serve as static sites behind the same sandbox (entrypoint: `index.html` or `README.md`, or pass `entrypoint`).

## CLI

```bash
serve-mcp serve                                  # HTTP shelf only
serve-mcp publish ./report.md --title "Report"   # publish without an agent
serve-mcp list
```

## Config

Environment variables (all optional):

```txt
SERVE_MCP_HOST           default 127.0.0.1
SERVE_MCP_PORT           default 7331
SERVE_MCP_DATA_DIR       default ~/.local/share/serve-mcp
SERVE_MCP_ALLOWED_ROOTS  colon-separated roots for path/folder publishing (default: anywhere readable)
```

## Non-goals

Not a CDN, not a deploy platform, not a filesystem browser, not a CMS. It does one thing: **publish generated artifacts → render safely → remember them → list them.**

## Development

```bash
npm install
npm test          # node:test — core, http, mcp round-trip
npm start         # HTTP server
```

Requires Node ≥ 22.5 (uses built-in `node:sqlite`). MIT.
