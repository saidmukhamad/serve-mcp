import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createApp } from "../src/http.ts";
import { makeDeps } from "./helpers.ts";

function setup() {
  const deps = makeDeps();
  const app = createApp(deps);
  const get = (p: string, method = "GET") => app.request(p, { method });
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
  assert.match(shellHtml, /sandbox="[^"]*"/, "iframe must be sandboxed");
  assert.doesNotMatch(shellHtml, /allow-scripts/, "no scripts without opt-in");
  assert.ok(shell.headers.get("content-security-policy"));

  const frame = await get(`/frame/${ing.id}`);
  assert.equal(frame.status, 200);
  assert.match(frame.headers.get("content-security-policy")!, /script-src 'none'/);
  assert.match(await frame.text(), /<h1>Report<\/h1>/);

  const raw = await get(`/raw/${ing.id}`);
  assert.equal(raw.status, 200);
  assert.match(await raw.text(), /# Report/);

  const api = await get("/api/publications");
  const json = (await api.json()) as { publications: { previewUrl: string }[] };
  assert.equal(json.publications.length, 1);
  assert.match(json.publications[0]!.previewUrl, /\/p\/the-report$/);

  assert.equal((await get("/p/nope")).status, 404);
  assert.equal((await get("/frame/art_nope")).status, 404);
  cleanup();
});

test("html artifact served in no-script frame; allowScripts loosens sandbox", async () => {
  const { store, registry, get, cleanup } = setup();
  const ing = store.ingest({ type: "content", content: "<h1>hi</h1><script>x()</script>", filename: "p.html" });
  registry.publish({ ingested: ing, title: "Plain", sourceType: "content" });
  const frame = await get(`/frame/${ing.id}`);
  assert.match(frame.headers.get("content-security-policy")!, /script-src 'none'/);

  const ing2 = store.ingest({ type: "content", content: "<script>x()</script>", filename: "app.html" });
  registry.publish({
    ingested: ing2,
    title: "App",
    sourceType: "content",
    renderer: { name: "html-sandbox", options: { allowScripts: true } },
  });
  const frame2 = await get(`/frame/${ing2.id}`);
  assert.doesNotMatch(frame2.headers.get("content-security-policy")!, /script-src 'none'/);
  const shell2 = await get("/p/app");
  assert.match(await shell2.text(), /sandbox="[^"]*allow-scripts[^"]*"/);
  cleanup();
});

test("shell and gallery show description and git provenance", async () => {
  const { store, registry, get, cleanup } = setup();
  const ing = store.ingest({ type: "content", content: "# r", filename: "report.md" });
  registry.publish({
    ingested: ing,
    title: "Prov Report",
    description: "Weekly numbers",
    sourceType: "path",
    sourceLabel: "./report.md",
    context: {
      path: "/home/dev/proj/report.md",
      git: { branch: "main", remote: "git@github.com:acme/widgets.git", commit: "a".repeat(40) },
    },
  });

  const shell = await (await get("/p/prov-report")).text();
  assert.match(shell, /Weekly numbers/);
  assert.match(shell, /<code>\/home\/dev\/proj\/<\/code> <span class="branch">\(main\)<\/span>/, "fish-style dir (branch)");
  assert.match(shell, /<a href="https:\/\/github\.com\/acme\/widgets" target="_blank" rel="noopener">github\.com\/acme\/widgets<\/a>/);

  const gallery = await (await get("/")).text();
  assert.match(gallery, /Weekly numbers/);
  assert.match(gallery, /github\.com\/acme\/widgets/);
  cleanup();
});

test("gallery cards: cover link opens publication, menu offers raw + delete; DELETE removes everything", async () => {
  const { store, registry, get, cleanup } = setup();
  const ing = store.ingest({ type: "content", content: "# bye", filename: "bye.md" });
  registry.publish({ ingested: ing, title: "Bye", slug: "bye", sourceType: "content" });

  const gallery = await (await get("/")).text();
  assert.match(gallery, /<a class="cover" href="\/p\/bye"/);
  assert.match(gallery, /<details class="menu">/);
  assert.match(gallery, new RegExp(`href="/raw/${ing.id}"`));
  assert.match(gallery, /data-del="bye"/);

  const artifactDir = store.dirFor(ing.id);
  const fs = await import("node:fs");
  assert.ok(fs.existsSync(artifactDir));

  const del = await get("/api/publications/bye", "DELETE");
  assert.equal(del.status, 200);
  assert.equal(((await del.json()) as { revisions: number }).revisions, 1);
  assert.equal((await get("/p/bye")).status, 404);
  assert.equal((await get(`/frame/${ing.id}`)).status, 404);
  assert.equal(fs.existsSync(artifactDir), false, "artifact files removed from store");

  assert.equal((await get("/api/publications/nope", "DELETE")).status, 404);
  cleanup();
});

test("markdown external links open in a new tab; internal links stay in-frame", async () => {
  const { store, registry, get, cleanup } = setup();
  const ing = store.ingest({
    type: "content",
    content: "[docs](https://tailscale.com/kb) and [local](other.md)",
    filename: "links.md",
  });
  registry.publish({ ingested: ing, title: "Links", sourceType: "content" });
  const html = await (await get(`/frame/${ing.id}`)).text();
  assert.match(html, /<a href="https:\/\/tailscale\.com\/kb" target="_blank" rel="noopener">/);
  assert.match(html, /<a href="other\.md">/);
  cleanup();
});

test("static folder serving with traversal protection", async () => {
  const { store, registry, get, dataDir, cleanup } = setup();
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
  assert.match(css.headers.get("content-type")!, /text\/css/);

  const evil = await get(`/frame/${ing.id}/..%2f..%2fregistry.sqlite`);
  assert.equal(evil.status, 404);
  cleanup();
});

test("folder navigation: per-dir indexes, dir redirect, ../ listing links", async () => {
  const { store, registry, get, dataDir, cleanup } = setup();
  const site = path.join(dataDir, "docs");
  fs.mkdirSync(path.join(site, "guides"), { recursive: true });
  fs.mkdirSync(path.join(site, "assets"), { recursive: true });
  fs.writeFileSync(path.join(site, "index.md"), "# Docs home\n\n[guide](guides/setup.md)");
  fs.writeFileSync(path.join(site, "guides", "index.md"), "# Guides\n\n[back home](../index.md)");
  fs.writeFileSync(path.join(site, "guides", "setup.md"), "# Setup\n\n![chart](../assets/chart.csv)");
  fs.writeFileSync(path.join(site, "assets", "chart.csv"), "x,y\n1,2\n");
  const ing = store.ingest({ type: "folder", path: site });
  registry.publish({ ingested: ing, title: "Docs", sourceType: "folder" });

  const home = await get(`/frame/${ing.id}/`);
  assert.match(await home.text(), /Docs home/, "root index.md renders");

  const dirNoSlash = await get(`/frame/${ing.id}/guides`);
  assert.equal(dirNoSlash.status, 302);
  assert.match(dirNoSlash.headers.get("location")!, /\/guides\/$/);

  const guides = await get(`/frame/${ing.id}/guides/`);
  assert.match(await guides.text(), /<h1>Guides<\/h1>/, "nested dir serves its own index.md");
  assert.match(await (await get(`/frame/${ing.id}/guides/`)).text(), /href="\.\.\/index\.md"/);

  const upLink = await get(`/frame/${ing.id}/index.md`);
  assert.equal(upLink.status, 200, "../index.md from guides/ resolves to a served file");

  const asset = await get(`/frame/${ing.id}/assets/chart.csv`);
  assert.equal(asset.status, 200, "../assets/chart.csv from guides/setup.md resolves");
  assert.match(asset.headers.get("content-type")!, /text\/html/, "csv renders as a view");
  const assetHtml = await asset.text();
  assert.match(assetHtml, /<table>/);
  assert.match(assetHtml, /href="\?raw"/, "rendered view links to the raw file");

  const rawAsset = await get(`/frame/${ing.id}/assets/chart.csv?raw`);
  assert.match(rawAsset.headers.get("content-type")!, /text\/csv/, "?raw serves the actual file");
  assert.match(rawAsset.headers.get("content-disposition")!, /attachment/);
  assert.match(await rawAsset.text(), /x,y/);

  const listing = await get(`/frame/${ing.id}/assets/`);
  assert.equal(listing.status, 200);
  const listingHtml = await listing.text();
  assert.match(listingHtml, /href="\.\.\/">\.\.\//, "listing has ../ link");
  assert.match(listingHtml, /chart\.csv/);
  cleanup();
});

test("folder without any index gets a browsable listing", async () => {
  const { store, registry, get, dataDir, cleanup } = setup();
  const folder = path.join(dataDir, "dump");
  fs.mkdirSync(path.join(folder, "logs"), { recursive: true });
  fs.writeFileSync(path.join(folder, "data.json"), "{}");
  fs.writeFileSync(path.join(folder, "logs", "run.log"), "ok");
  const ing = store.ingest({ type: "folder", path: folder });
  registry.publish({ ingested: ing, title: "Dump", sourceType: "folder" });

  const listing = await get(`/frame/${ing.id}/`);
  assert.equal(listing.status, 200);
  const html = await listing.text();
  assert.match(html, /logs\//);
  assert.match(html, /data\.json/);
  assert.doesNotMatch(html, /href="\.\.\/"/, "no ../ at folder root");

  const raw = await get(`/raw/${ing.id}`);
  assert.equal(raw.status, 302, "raw of index-less folder redirects to listing");
  cleanup();
});
