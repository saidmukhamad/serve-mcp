# Changelog

All notable changes to this project. Format follows [Keep a Changelog](https://keepachangelog.com); versions follow [SemVer](https://semver.org) (0.x — expect movement).

## [Unreleased]

### Added
- `serve-mcp restart` (alias `apply`) — restarts the shelf wherever it lives: through the service manager when installed, by pid otherwise. `config` now points at it after writing.
- This changelog.

### Changed
- README: lifecycle section (three modes + permanent setup recipe), trimmed Rendering & safety.
- Dev convention: `-dev` version suffix between releases; conventional commit prefixes.
- CI publishes every main push as `<version>.<short-sha>` on the npm `dev` dist-tag while the version is `-dev`.

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
