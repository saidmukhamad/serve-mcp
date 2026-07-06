import fs from "node:fs";
import path from "node:path";
import type { GitInfo, Source, SourceContext } from "./types.ts";

export function captureContext(source: Source): SourceContext {
  const ctx: SourceContext = {};
  let dir: string | null = null;
  if (source.type === "content") {
    ctx.cwd = process.cwd();
    dir = ctx.cwd;
  } else {
    try {
      const abs = path.resolve(source.path);
      ctx.path = abs;
      dir = fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
    } catch {
      dir = null;
    }
  }
  const git = dir ? readGitInfo(dir) : null;
  if (git) ctx.git = git;
  return ctx;
}

// Reads branch/remote/commit straight from .git files — no git subprocess,
// so it works without git installed and costs microseconds.
export function readGitInfo(startDir: string): GitInfo | null {
  try {
    const dirs = findGitDir(path.resolve(startDir));
    if (!dirs) return null;
    const info: GitInfo = {};
    const head = fs.readFileSync(path.join(dirs.gitdir, "HEAD"), "utf8").trim();
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    if (ref) {
      info.branch = ref[1];
      info.commit = resolveRef(dirs.commondir, `refs/heads/${ref[1]}`) ?? undefined;
    } else if (/^[0-9a-f]{40}/.test(head)) {
      info.commit = head.slice(0, 40);
    }
    const remote = readRemoteUrl(path.join(dirs.commondir, "config"));
    if (remote) info.remote = remote;
    return info.branch || info.remote || info.commit ? info : null;
  } catch {
    return null;
  }
}

// Handles regular repos (.git dir) and worktrees (.git file with a gitdir
// pointer; shared config/refs live in the commondir).
function findGitDir(start: string): { gitdir: string; commondir: string } | null {
  let dir = start;
  for (;;) {
    const dotGit = path.join(dir, ".git");
    if (fs.existsSync(dotGit)) {
      let gitdir = dotGit;
      if (fs.statSync(dotGit).isFile()) {
        const m = fs.readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)\s*$/m);
        if (!m) return null;
        gitdir = path.resolve(dir, m[1]!.trim());
      }
      let commondir = gitdir;
      const cd = path.join(gitdir, "commondir");
      if (fs.existsSync(cd)) commondir = path.resolve(gitdir, fs.readFileSync(cd, "utf8").trim());
      return { gitdir, commondir };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolveRef(commondir: string, ref: string): string | null {
  const refFile = path.join(commondir, ref);
  if (fs.existsSync(refFile)) return fs.readFileSync(refFile, "utf8").trim();
  const packed = path.join(commondir, "packed-refs");
  if (!fs.existsSync(packed)) return null;
  for (const line of fs.readFileSync(packed, "utf8").split("\n")) {
    if (line.endsWith(` ${ref}`)) return line.slice(0, 40);
  }
  return null;
}

function readRemoteUrl(configPath: string): string | null {
  if (!fs.existsSync(configPath)) return null;
  let fallback: string | null = null;
  for (const section of fs.readFileSync(configPath, "utf8").split(/^\[/m)) {
    const m = section.match(/^remote "([^"]+)"\]([\s\S]*)/);
    if (!m) continue;
    const url = m[2]!.match(/^\s*url\s*=\s*(.+)$/m)?.[1]?.trim();
    if (!url) continue;
    if (m[1] === "origin") return url;
    fallback ??= url;
  }
  return fallback;
}
