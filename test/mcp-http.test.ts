import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttp } from "../src/http.ts";
import { makeDeps } from "./helpers.ts";

test("MCP over HTTP: remote client publishes and reads via /mcp", async () => {
  const deps = makeDeps({ ephemeral: true });
  const started = await startHttp(deps);
  assert.ok(started);

  const transport = new StreamableHTTPClientTransport(new URL(`${started.baseUrl}/mcp`));
  const client = new Client({ name: "remote-agent", version: "0" });
  await client.connect(transport);

  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((t) => t.name).sort(),
    ["artifact_list", "artifact_publish"]
  );

  const pub = await client.callTool({
    name: "artifact_publish",
    arguments: {
      source: { type: "content", filename: "remote.md", content: "# Published over HTTP" },
      title: "Remote note",
      slug: "remote-note",
    },
  });
  assert.equal(pub.isError ?? false, false);
  const text = (pub.content as { text?: string }[])[0]!.text!;
  assert.match(text, /Published: http:\/\/127\.0\.0\.1:\d+\/p\/remote-note/);

  const preview = await fetch(`${started.baseUrl}/p/remote-note`);
  assert.equal(preview.status, 200);

  const read = await client.readResource({ uri: "publication://remote-note" });
  const doc = JSON.parse((read.contents[0] as { text: string }).text);
  assert.equal(doc.slug, "remote-note");

  const list = await client.callTool({ name: "artifact_list", arguments: {} });
  assert.match((list.content as { text: string }[])[0]!.text, /Remote note/);

  await client.close();
  started.server.close();
  deps.cleanup();
});
