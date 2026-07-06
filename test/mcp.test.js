import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp.js";
import { makeDeps } from "./helpers.js";

async function connect() {
  const deps = makeDeps();
  const mcp = createMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
  return { ...deps, client };
}

test("artifact_publish + artifact_list + resources round trip", async () => {
  const { client, cleanup } = await connect();

  const pub = await client.callTool({
    name: "artifact_publish",
    arguments: {
      source: { type: "content", filename: "note.md", content: "# Note" },
      title: "A Note",
      slug: "a-note",
      tags: ["test"],
    },
  });
  assert.equal(pub.isError ?? false, false);
  assert.match(pub.content[0].text, /Published: http:\/\/127\.0\.0\.1:\d+\/p\/a-note/);
  assert.equal(pub.content[1].type, "resource_link");
  assert.equal(pub.structuredContent.publication.slug, "a-note");
  assert.match(pub.structuredContent.urls.raw, /\/raw\/art_/);

  // revision via updateExisting
  const rev = await client.callTool({
    name: "artifact_publish",
    arguments: {
      source: { type: "content", filename: "note.md", content: "# Note v2" },
      slug: "a-note",
      updateExisting: true,
    },
  });
  assert.equal(rev.structuredContent.publication.revisions.length, 2);

  // conflict without updateExisting is an error result, not a throw
  const conflict = await client.callTool({
    name: "artifact_publish",
    arguments: { source: { type: "content", filename: "note.md", content: "x" }, slug: "a-note" },
  });
  assert.equal(conflict.isError, true);
  assert.match(conflict.content[0].text, /updateExisting/);

  const list = await client.callTool({ name: "artifact_list", arguments: {} });
  assert.match(list.content[0].text, /A Note \[markdown\]/);
  assert.equal(list.structuredContent.publications.length, 1);

  const resources = await client.listResources();
  const uris = resources.resources.map((r) => r.uri);
  assert.ok(uris.includes("registry://publications"));
  assert.ok(uris.includes("publication://a-note"));

  const read = await client.readResource({ uri: "publication://a-note" });
  const doc = JSON.parse(read.contents[0].text);
  assert.equal(doc.slug, "a-note");
  assert.match(doc.previewUrl, /\/p\/a-note$/);

  const artUri = pub.content[1].uri;
  const rawRead = await client.readResource({ uri: artUri });
  assert.equal(rawRead.contents[0].text, "# Note");

  await client.close();
  cleanup();
});

test("publish from a real file path", async () => {
  const { client, dataDir, cleanup } = await connect();
  const fs = await import("node:fs");
  const path = await import("node:path");
  const file = path.join(dataDir, "work.html");
  fs.writeFileSync(file, "<h1>work</h1>");
  const pub = await client.callTool({
    name: "artifact_publish",
    arguments: { source: { type: "path", path: file }, title: "Work" },
  });
  assert.equal(pub.isError ?? false, false);
  assert.equal(pub.structuredContent.artifact.kind, "html");
  await client.close();
  cleanup();
});
