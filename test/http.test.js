import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/http.js";
import { makeDeps } from "./helpers.js";

function setup() {
  const deps = makeDeps();
  const app = createApp(deps);
  const get = (p) => app.request(p);
  return { ...deps, get };
}

test("gallery, shell, frame, raw, api", async () => {
  const { store, registry, get, cleanup } = setup();
  const ing = store.ingest({
    type: "content",
    content: "# Report\n\n<script>alert(1)</script>",
    filename: "report.md",
  });
  registry.publish({ ingested: ing, title: "The Report", sourceType: "content", tags: ["x"] });

  const gallery = await get("/");
  assert.equal(gallery.status, 200);
  assert.match(await gallery.text(), /The Report/);

  const shell = await get("/p/the-report");
  assert.equal(shell.status, 200);
  const shellHtml = await shell.text();
  assert.match(shellHtml, /sandbox=""/, "iframe must be sandboxed with no scripts");
  assert.ok(shell.headers.get("content-security-policy"));

  const frame = await get(`/frame/${ing.id}`);
  assert.equal(frame.status, 200);
  const csp = frame.headers.get("content-security-policy");
  assert.match(csp, /script-src 'none'/, "frame CSP must block scripts");
  assert.match(await frame.text(), /<h1>Report<\/h1>/);

  const raw = await get(`/raw/${ing.id}`);
  assert.equal(raw.status, 200);
  assert.match(await raw.text(), /# Report/);

  const api = await get("/api/publications");
  const json = await api.json();
  assert.equal(json.publications.length, 1);
  assert.match(json.publications[0].previewUrl, /\/p\/the-report$/);

  assert.equal((await get("/p/nope")).status, 404);
  assert.equal((await get("/frame/art_nope")).status, 404);
  cleanup();
});

test("html artifact served in no-script frame; allowScripts loosens sandbox", async () => {
  const { store, registry, get, cleanup } = setup();
  const ing = store.ingest({ type: "content", content: "<h1>hi</h1><script>x()</script>", filename: "p.html" });
  registry.publish({ ingested: ing, title: "Plain", sourceType: "content" });
  const frame = await get(`/frame/${ing.id}`);
  assert.match(frame.headers.get("content-security-policy"), /script-src 'none'/);

  const ing2 = store.ingest({ type: "content", content: "<script>x()</script>", filename: "app.html" });
  registry.publish({
    ingested: ing2,
    title: "App",
    sourceType: "content",
    renderer: { name: "html-sandbox", options: { allowScripts: true } },
  });
  const frame2 = await get(`/frame/${ing2.id}`);
  assert.doesNotMatch(frame2.headers.get("content-security-policy"), /script-src 'none'/);
  const shell2 = await get("/p/app");
  assert.match(await shell2.text(), /sandbox="allow-scripts"/);
  cleanup();
});

test("static folder serving with traversal protection", async () => {
  const { store, registry, get, dataDir, cleanup } = setup();
  const fs = await import("node:fs");
  const path = await import("node:path");
  const site = path.join(dataDir, "site");
  fs.mkdirSync(path.join(site, "sub"), { recursive: true });
  fs.writeFileSync(path.join(site, "index.html"), "<h1>site home</h1>");
  fs.writeFileSync(path.join(site, "sub", "style.css"), "body{color:red}");
  const ing = store.ingest({ type: "folder", path: site });
  registry.publish({ ingested: ing, title: "Site", sourceType: "folder" });

  const redirect = await get(`/frame/${ing.id}`);
  assert.equal(redirect.status, 302);

  const home = await get(`/frame/${ing.id}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /site home/);

  const css = await get(`/frame/${ing.id}/sub/style.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type"), /text\/css/);

  const evil = await get(`/frame/${ing.id}/..%2f..%2fregistry.sqlite`);
  assert.equal(evil.status, 404);
  cleanup();
});
