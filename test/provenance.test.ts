import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureContext, readGitInfo } from "../src/provenance.ts";

function fakeRepo(head: string, config = "", refs: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "serve-mcp-git-"));
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), head);
  if (config) fs.writeFileSync(path.join(dir, ".git", "config"), config);
  for (const [ref, sha] of Object.entries(refs)) {
    const p = path.join(dir, ".git", ref);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, sha);
  }
  return dir;
}

const SHA = "a".repeat(40);

test("readGitInfo: branch, remote, commit from ref file", () => {
  const dir = fakeRepo(
    "ref: refs/heads/feature-x\n",
    `[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:acme/widgets.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
    { "refs/heads/feature-x": `${SHA}\n` }
  );
  assert.deepEqual(readGitInfo(dir), {
    branch: "feature-x",
    commit: SHA,
    remote: "git@github.com:acme/widgets.git",
  });
  // nested dirs walk up to the repo root
  const sub = path.join(dir, "deep", "nested");
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(readGitInfo(sub)?.branch, "feature-x");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readGitInfo: packed refs and detached HEAD", () => {
  const packed = fakeRepo("ref: refs/heads/main\n", "", {});
  fs.writeFileSync(
    path.join(packed, ".git", "packed-refs"),
    `# pack-refs with: peeled fully-peeled sorted\n${SHA} refs/heads/main\n`
  );
  assert.equal(readGitInfo(packed)?.commit, SHA);
  fs.rmSync(packed, { recursive: true, force: true });

  const detached = fakeRepo(`${SHA}\n`);
  const info = readGitInfo(detached);
  assert.equal(info?.commit, SHA);
  assert.equal(info?.branch, undefined);
  fs.rmSync(detached, { recursive: true, force: true });
});

test("readGitInfo: no repo means null", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "serve-mcp-nogit-"));
  assert.equal(readGitInfo(path.join(dir)), readGitInfo(dir));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("captureContext: path source records path + git; content records cwd", () => {
  const dir = fakeRepo("ref: refs/heads/main\n", `[remote "origin"]\n\turl = https://github.com/acme/widgets.git\n`);
  fs.writeFileSync(path.join(dir, "report.md"), "# r");
  const ctx = captureContext({ type: "path", path: path.join(dir, "report.md") });
  assert.equal(ctx.path, path.join(dir, "report.md"));
  assert.equal(ctx.git?.branch, "main");
  assert.equal(ctx.git?.remote, "https://github.com/acme/widgets.git");
  fs.rmSync(dir, { recursive: true, force: true });

  const contentCtx = captureContext({ type: "content", content: "x" });
  assert.equal(contentCtx.cwd, process.cwd());
});
