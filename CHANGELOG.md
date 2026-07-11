# Changelog

All notable changes to this project. Format follows [Keep a Changelog](https://keepachangelog.com); versions follow [SemVer](https://semver.org) (0.x — expect movement).

## [Unreleased]

### Changed
- HTML artifacts and static folders now run inline and same-shelf JavaScript by default. Set the new `stripScripts` config option (or `SERVE_MCP_STRIP_SCRIPTS`) to `true` to force scripts off server-wide; `renderer.options.allowScripts: false` still disables scripts for one artifact.

## [0.0.9] - 2026-07-08

### Added
- Bare-path shorthand: `serve-mcp ./report.md` publishes and prints the URL; `serve-mcp .` serves the current directory, live.
- Folder deep links: browsing a served folder updates the address bar (`/p/:slug/f/<path>`), so reload and share keep the place; listing links navigate the top window.
- Mobile pass: cards, headers, and menus adapt below 640px; comfortable touch targets on coarse pointers; `100dvh` shell; frame tables scroll horizontally; no iOS zoom-on-focus.

## [0.0.8] - 2026-07-08

### Fixed
- Only one server, guaranteed: simultaneous ephemeral-mode sessions now elect a single shelf via a start lock (fixed ports already had the OS bind as their lock), and `serve-mcp serve` refuses to start next to a running shelf.
- Concurrent cold starts no longer crash on SQLite's WAL conversion (`busy_timeout` + retry).

### Added
- Proactive publishing: MCP instructions and the `artifact_publish` description now tell agents to publish viewable output without being asked; `skills/publish-artifact/SKILL.md` ships as an auto-triggering Claude Code skill (copy to `~/.claude/skills/`).

## [0.0.7] - 2026-07-08

### Added
- Dev builds identify as `<version>-dev.<commit>` — `serve-mcp --version` and the MCP handshake include the commit when running from a checkout; CI publishes the same shape to the npm `dev` tag.
- `/healthz` reports the running version.
- README: the permanent setup (always-on service) moved to the top.

## [0.0.6] - 2026-07-08

### Added
- Live publications: path/folder sources serve straight from the workspace via symlink — edits show on refresh. **Live is the default**; `live: false` (CLI `--snapshot`) freezes an immutable copy. Gallery and preview show a `live` badge.
- `serve-mcp restart` (alias `apply`) — restarts the shelf wherever it lives: through the service manager when installed, by pid otherwise. `config` now points at it after writing.
- This changelog.

### Changed
- README: lifecycle section (three modes + permanent setup recipe), trimmed Rendering & safety.
- Dev convention: `-dev` version suffix between releases; conventional commit prefixes.
- CI publishes every main push as `<version>.<short-sha>` on the npm `dev` dist-tag while the version is `-dev`.
- `serve-mcp version` / `--version` / `-v`.
- Local `commit-msg` hook enforcing the commit prefixes (zero-dep, via `core.hooksPath`).

## [0.0.4] - 2026-07-08

### Added
- Always-on shelf: `serve-mcp service install|start|stop|restart|status|logs|uninstall` — launchd agent on macOS, systemd user unit on Linux, Task Scheduler task on Windows. All user-level, no root/admin.
- Windows service runs hidden at logon via `wscript` and restarts on failure (Task Scheduler XML with `RestartOnFailure`, unlimited execution time, least privilege).
- `service logs` tails `serve.log` (journalctl on Linux); WSL detection warns that systemd user services may be unavailable there.
- Runtime sanity checks on `service install`: warns on version-manager-pinned node paths, npx-cache installs, and too-old runtimes.

### Changed
- Runtime floor lowered from Node 22.18 to **22.5** (the actual `node:sqlite` minimum; 22.18 is only needed to develop).
- macOS service uses a reverse-DNS label (`io.github.saidmukhamad.serve-mcp`) and modern `launchctl bootstrap`/`bootout`; old bare-label installs migrate automatically.

## [0.0.3] - 2026-07-07

### Added
- Bare `serve-mcp` on a terminal shows shelf status + publications instead of opening an MCP stdio session (MCP mode now requires explicit `mcp` or piped stdin).
- `serve-mcp config [<key> [<value>]]` — read/write `config.json` from the CLI; empty value unsets.
- MCP server `instructions` steering agents to `artifact_publish` (and its preview URLs) over hosted pages or ad-hoc HTTP servers.

### Fixed
- `node:sqlite` experimental warning no longer printed on every invocation.
- `serve-mcp list` says `(shelf is empty)` instead of nothing.
- MCP handshake reports the real package version.

## [0.0.2] - 2026-07-07

### Fixed
- README images render on npmjs.com (absolute URLs); `repository`/`homepage`/`bugs` metadata added.

## [0.0.1] - 2026-07-07

Initial release: MCP artifact shelf — `artifact_publish`/`artifact_list`/`artifact_delete` tools, sandboxed HTML/Markdown/CSV/JSON/folder previews (CSP `script-src 'none'`, nonce-gated mermaid), SQLite registry with stable slugs + immutable revisions, multi-agent port discovery via `server.json`, git provenance capture without a git subprocess, Tailscale detection + MagicDNS advertising without Tailscale tooling. Published scoped as `@saidmukhamad/serve-mcp` (unscoped name blocked by npm similarity rules).
