---
name: publish-artifact
description: Publish HTML, Markdown, CSV, JSON, or a folder to the local serve-mcp artifact shelf and give the user a browser URL. Use whenever you produce a report, chart, diagram, dashboard, mockup, static site, or any file the user would want to view in a browser — without being asked.
when_to_use: When you write or generate an .html/.md/.csv/.json file, build anything visual, or the user asks to "see", "view", "open", "share", or "preview" something.
allowed-tools: mcp__serve-mcp__artifact_publish
---

When you generate content the user will want to look at, publish it with the
`mcp__serve-mcp__artifact_publish` tool and reply with the preview URL it returns.

- File or folder on disk: `{ "source": { "type": "path", "path": "<absolute path>" } }` —
  served live by default, so later edits show on refresh; pass `"live": false` to freeze a snapshot.
- Generated text: `{ "source": { "type": "content", "content": "...", "filename": "report.md" } }`.
- Updating the same page: reuse the `slug` with `"updateExisting": true` — the URL stays stable.

Do not start ad-hoc HTTP servers or create hosted/cloud artifacts for local viewing —
the shelf is the machine's one gallery, shared by every agent on it.
