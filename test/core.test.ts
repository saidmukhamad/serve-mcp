import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { detectKind, detectMime } from "../src/kinds.ts";
import { slugify } from "../src/registry.ts";
import { parseCsv } from "../src/render.ts";
import { makeDeps } from "./helpers.ts";

test("kind detection", () => {
  assert.equal(detectKind("report.md"), "markdown");
  assert.equal(detectKind("page.html"), "html");
  assert.equal(detectKind("chart.svg"), "svg");
  assert.equal(detectKind("data.json"), "json");
  assert.equal(detectKind("x", true), "static-folder");
  assert.equal(detectKind("notes.unknownext"), "text");
  assert.equal(detectMime("a.png"), "image/png");
});

test("slugify", () => {
  assert.equal(slugify("Work Explanation!"), "work-explanation");
  assert.equal(slugify("report.md"), "report");
  assert.ok(slugify("!!!").length > 0);
});

test("csv parser handles quotes", () => {
  const rows = parseCsv('a,b\n"1,5","say ""hi"""\n');
  assert.deepEqual(rows, [["a", "b"], ["1,5", 'say "hi"']]);
});

test("store ingests content and rejects traversal", () => {
  const { store, cleanup } = makeDeps();
  const ing = store.ingest({ type: "content", content: "# t", filename: "t.md" });
  assert.equal(ing.kind, "markdown");
  assert.equal(store.readSource(ing.id, ing.filename).toString(), "# t");
  assert.throws(() => store.readSource(ing.id, "../../etc/passwd"));
  assert.equal(store.statFolderPath(ing.id, "../secret"), null);
  cleanup();
});

test("store ingests folders with entrypoint detection", () => {
  const { store, dataDir, cleanup } = makeDeps();
  const site = path.join(dataDir, "site");
  fs.mkdirSync(site, { recursive: true });
  fs.writeFileSync(path.join(site, "index.html"), "<h1>site</h1>");
  fs.writeFileSync(path.join(site, "style.css"), "body{}");
  const ing = store.ingest({ type: "folder", path: site });
  assert.equal(ing.kind, "static-folder");
  assert.equal(ing.filename, "files/index.html");
  assert.equal(store.statFolderPath(ing.id, "style.css")?.type, "file");
  cleanup();
});

test("store ingests folders without entrypoint", () => {
  const { store, dataDir, cleanup } = makeDeps();
  const folder = path.join(dataDir, "assets");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "data.csv"), "a,b\n1,2\n");
  const ing = store.ingest({ type: "folder", path: folder });
  assert.equal(ing.filename, "files");
  cleanup();
});

test("live file: edits show through, content sources rejected", () => {
  const { store, registry, cleanup, dataDir } = makeDeps();
  const src = path.join(dataDir, "notes.md");
  fs.writeFileSync(src, "# v1");
  const ing = store.ingest({ type: "path", path: src }, undefined, true);
  assert.equal(ing.live, true);
  assert.equal(store.readSource(ing.id, ing.filename).toString(), "# v1");

  fs.writeFileSync(src, "# v2 edited");
  assert.equal(store.readSource(ing.id, ing.filename).toString(), "# v2 edited");

  const { artifact, publication } = registry.publish({ ingested: ing, title: "Notes", sourceType: "path" });
  assert.equal(artifact.live, true);
  const listed = registry.listPublications({}).publications.find((p) => p.id === publication.id);
  assert.equal(listed?.live, true);

  assert.throws(() => store.ingest({ type: "content", content: "x", filename: "x.md" }, undefined, true), /live mode/);
  cleanup();
});

test("live folder: new files appear, delete removes only the link", () => {
  const { store, cleanup, dataDir } = makeDeps();
  const site = path.join(dataDir, "livesite");
  fs.mkdirSync(site, { recursive: true });
  fs.writeFileSync(path.join(site, "index.html"), "<h1>v1</h1>");
  const ing = store.ingest({ type: "folder", path: site }, undefined, true);
  assert.equal(ing.live, true);
  assert.equal(ing.filename, "files/index.html");

  fs.writeFileSync(path.join(site, "new.csv"), "a,b\n");
  assert.equal(store.statFolderPath(ing.id, "new.csv")?.type, "file");
  assert.ok(store.listFolder(ing.id, ".").some((e) => e.name === "new.csv"));

  store.remove(ing.id);
  assert.ok(fs.existsSync(path.join(site, "index.html")), "source folder must survive artifact removal");
  cleanup();
});

test("registry publish, revisions, conflicts, listing", () => {
  const { store, registry, cleanup } = makeDeps();
  const ing1 = store.ingest({ type: "content", content: "v1", filename: "doc.md" });
  const { publication } = registry.publish({ ingested: ing1, title: "Doc", sourceType: "content" });
  assert.equal(publication.slug, "doc");

  const ing2 = store.ingest({ type: "content", content: "v2", filename: "doc.md" });
  const r2 = registry.publish({ ingested: ing2, slug: "doc", updateExisting: true, sourceType: "content" });
  assert.equal(r2.publication.revisions.length, 2);
  assert.equal(r2.publication.latestArtifactId, ing2.id);

  const ing3 = store.ingest({ type: "content", content: "v3", filename: "doc.md" });
  assert.throws(
    () => registry.publish({ ingested: ing3, slug: "doc", sourceType: "content" }),
    /already exists/
  );

  const ing4 = store.ingest({ type: "content", content: "other", filename: "doc.md" });
  const r4 = registry.publish({ ingested: ing4, title: "Doc", sourceType: "content" });
  assert.equal(r4.publication.slug, "doc-2");

  const { publications } = registry.listPublications({ query: "doc" });
  assert.equal(publications.length, 2);
  cleanup();
});
