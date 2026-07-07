import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp.ts";
import { makeDeps } from "./helpers.ts";

async function connect() {
  const deps = makeDeps();
  const mcp = createMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
  return { ...deps, client };
}

interface PublishStructured {
  publication: { slug: string; revisions: string[] };
  artifact: { kind: string };
  urls: { raw: string; preview: string };
}

test("server advertises instructions steering agents to the shelf", async () => {
  const { client, cleanup } = await connect();
  const instructions = client.getInstructions();
  assert.ok(instructions);
  assert.match(instructions, /artifact_publish/);
  assert.match(instructions, /preview URL/);
  await client.close();
  cleanup();
});

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
  const pubContent = pub.content as { type: string; text?: string; uri?: string }[];
  assert.equal(pub.isError ?? false, false);
  assert.match(pubContent[0]!.text!, /Published: http:\/\/127\.0\.0\.1:\d+\/p\/a-note/);
  assert.equal(pubContent[1]!.type, "resource_link");
  const structured = pub.structuredContent as unknown as PublishStructured;
  assert.equal(structured.publication.slug, "a-note");
  assert.match(structured.urls.raw, /\/raw\/art_/);

  const rev = await client.callTool({
    name: "artifact_publish",
    arguments: {
      source: { type: "content", filename: "note.md", content: "# Note v2" },
      slug: "a-note",
      updateExisting: true,
    },
  });
  assert.equal((rev.structuredContent as unknown as PublishStructured).publication.revisions.length, 2);

  const conflict = await client.callTool({
    name: "artifact_publish",
    arguments: { source: { type: "content", filename: "note.md", content: "x" }, slug: "a-note" },
  });
  assert.equal(conflict.isError, true);
  assert.match((conflict.content as { text: string }[])[0]!.text, /updateExisting/);

  const list = await client.callTool({ name: "artifact_list", arguments: {} });
  assert.match((list.content as { text: string }[])[0]!.text, /A Note \[markdown\]/);

  const resources = await client.listResources();
  const uris = resources.resources.map((r) => r.uri);
  assert.deepEqual(uris, ["registry://publications"], "only the registry is enumerated");

  const read = await client.readResource({ uri: "publication://a-note" });
  const doc = JSON.parse((read.contents[0] as { text: string }).text);
  assert.equal(doc.slug, "a-note");
  assert.match(doc.previewUrl, /\/p\/a-note$/);

  const artUri = pubContent[1]!.uri!;
  const rawRead = await client.readResource({ uri: artUri });
  assert.equal((rawRead.contents[0] as { text: string }).text, "# Note");

  await client.close();
  cleanup();
});

test("artifact_delete removes publication, revisions, and files", async () => {
  const { client, store, cleanup } = await connect();
  const pub = await client.callTool({
    name: "artifact_publish",
    arguments: { source: { type: "content", filename: "gone.md", content: "# g" }, slug: "gone" },
  });
  const artifactId = (pub.structuredContent as { artifact: { id: string } }).artifact.id;
  assert.ok(fs.existsSync(store.dirFor(artifactId)));

  const del = await client.callTool({ name: "artifact_delete", arguments: { slug: "gone" } });
  assert.equal(del.isError ?? false, false);
  assert.match((del.content as { text: string }[])[0]!.text, /Deleted "gone" \(1 revision\)/);
  assert.equal(fs.existsSync(store.dirFor(artifactId)), false);

  const list = await client.callTool({ name: "artifact_list", arguments: {} });
  assert.match((list.content as { text: string }[])[0]!.text, /shelf is empty/);

  const missing = await client.callTool({ name: "artifact_delete", arguments: { slug: "gone" } });
  assert.equal(missing.isError, true);
  await client.close();
  cleanup();
});

test("publish from a real file path", async () => {
  const { client, dataDir, cleanup } = await connect();
  const file = path.join(dataDir, "work.html");
  fs.writeFileSync(file, "<h1>work</h1>");
  const pub = await client.callTool({
    name: "artifact_publish",
    arguments: { source: { type: "path", path: file }, title: "Work" },
  });
  assert.equal(pub.isError ?? false, false);
  assert.equal((pub.structuredContent as unknown as PublishStructured).artifact.kind, "html");
  await client.close();
  cleanup();
});
