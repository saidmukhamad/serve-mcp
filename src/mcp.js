import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { KINDS } from "./kinds.js";
import { withUrls } from "./registry.js";

const sourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("path"),
    path: z.string().describe("Path to a file (or folder) to snapshot and publish"),
  }),
  z.object({
    type: z.literal("content"),
    content: z.string().describe("Inline content to publish"),
    filename: z.string().optional().describe("Filename used for kind detection, e.g. report.md"),
    mimeType: z.string().optional(),
  }),
  z.object({
    type: z.literal("folder"),
    path: z.string().describe("Path to a folder to snapshot as a static site"),
    entrypoint: z.string().optional().describe("Relative entrypoint, defaults to index.html/README.md"),
  }),
]);

const publishInput = {
  source: sourceSchema,
  title: z.string().optional(),
  description: z.string().optional(),
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes")
    .max(64)
    .optional()
    .describe("Stable URL slot (/p/<slug>). Generated from title/filename if omitted."),
  updateExisting: z
    .boolean()
    .optional()
    .default(false)
    .describe("If the slug already exists, add a new revision instead of failing"),
  tags: z.array(z.string()).optional(),
  renderer: z
    .object({
      name: z.string().optional(),
      options: z
        .object({ allowScripts: z.boolean().optional().describe("Allow scripts in HTML previews (off by default)") })
        .passthrough()
        .optional(),
    })
    .optional(),
};

const listInput = {
  query: z.string().optional().describe("Substring match on title/slug/description"),
  tags: z.array(z.string()).optional(),
  kind: z.array(z.enum(KINDS)).optional(),
  limit: z.number().int().min(1).max(200).optional().default(50),
  cursor: z.string().optional(),
  orderBy: z.enum(["createdAt", "updatedAt", "title"]).optional().default("updatedAt"),
  order: z.enum(["asc", "desc"]).optional().default("desc"),
};

/**
 * Build the MCP server (tools + resources) on top of a registry/store pair.
 * Transport is attached by the caller.
 */
export function createMcpServer({ registry, store, config }) {
  const mcp = new McpServer(
    { name: "serve-mcp", version: "0.1.0" },
    { capabilities: { resources: { listChanged: true } } }
  );
  const base = config.baseUrl;

  mcp.registerTool(
    "artifact_publish",
    {
      title: "Publish artifact",
      description:
        "Snapshot a file, folder, or inline content into the artifact shelf and get a stable browser preview URL back. " +
        "Use the same slug with updateExisting:true to push new revisions of the same page.",
      inputSchema: publishInput,
    },
    async (input) => {
      const allowedRoots = process.env.SERVE_MCP_ALLOWED_ROOTS?.split(":").filter(Boolean);
      let ingested;
      try {
        ingested = store.ingest(input.source, allowedRoots);
      } catch (err) {
        return errorResult(`Failed to ingest source: ${err.message}`);
      }
      let result;
      try {
        result = registry.publish({
          ingested,
          title: input.title,
          description: input.description,
          slug: input.slug,
          updateExisting: input.updateExisting,
          tags: input.tags,
          renderer: input.renderer,
          sourceType: input.source.type,
          sourceLabel: input.source.type === "content" ? input.source.filename : input.source.path,
        });
      } catch (err) {
        return errorResult(err.message);
      }
      const publication = withUrls(result.publication, base, "publication");
      const artifact = withUrls(result.artifact, base, "artifact");
      const structured = {
        artifact,
        publication,
        urls: {
          preview: publication.previewUrl,
          raw: artifact.rawUrl,
          latest: publication.previewUrl,
        },
        resources: {
          artifactUri: artifact.resourceUri,
          publicationUri: publication.resourceUri,
        },
      };
      return {
        content: [
          { type: "text", text: `Published: ${publication.previewUrl}` },
          {
            type: "resource_link",
            uri: artifact.resourceUri,
            name: artifact.filename,
            description: `${artifact.kind} artifact for publication "${publication.slug}"`,
            mimeType: artifact.mimeType,
          },
        ],
        structuredContent: structured,
      };
    }
  );

  mcp.registerTool(
    "artifact_list",
    {
      title: "List publications",
      description: "List published artifacts on the shelf, newest first. Returns preview URLs humans can open.",
      inputSchema: listInput,
    },
    async (input) => {
      const { publications, nextCursor } = registry.listPublications(input);
      const decorated = publications.map((p) => withUrls(p, base, "publication"));
      const lines =
        decorated.length === 0
          ? ["(shelf is empty)"]
          : decorated.map((p) => `- ${p.title} [${p.kind}] ${p.previewUrl} (${p.revisions.length} rev)`);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: { publications: decorated, nextCursor },
      };
    }
  );

  // ---- resources --------------------------------------------------------

  mcp.registerResource(
    "publications",
    "registry://publications",
    {
      title: "Published artifacts",
      description: "All publications on the shelf as JSON",
      mimeType: "application/json",
    },
    async (uri) => {
      const { publications } = registry.listPublications({ limit: 200 });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(publications.map((p) => withUrls(p, base, "publication")), null, 2),
          },
        ],
      };
    }
  );

  mcp.registerResource(
    "publication",
    new ResourceTemplate("publication://{slug}", {
      list: async () => {
        const { publications } = registry.listPublications({ limit: 200 });
        return {
          resources: publications.map((p) => ({
            uri: `publication://${p.slug}`,
            name: p.slug,
            title: p.title,
            description: p.description,
            mimeType: "application/json",
          })),
        };
      },
    }),
    { title: "Publication", description: "Compact JSON for one publication (URLs, latest revision)" },
    async (uri, { slug }) => {
      const pub = registry.getPublication(slug);
      if (!pub) throw new Error(`publication not found: ${slug}`);
      const artifact = registry.getArtifact(pub.latestArtifactId);
      const compact = {
        ...withUrls(pub, base, "publication"),
        rawUrl: `${base}/raw/${artifact.id}`,
        kind: artifact.kind,
      };
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(compact, null, 2) }],
      };
    }
  );

  mcp.registerResource(
    "artifact",
    new ResourceTemplate("artifact://{id}", { list: undefined }),
    { title: "Artifact", description: "Raw source of an artifact revision" },
    async (uri, { id }) => {
      const artifact = registry.getArtifact(id);
      if (!artifact) throw new Error(`artifact not found: ${id}`);
      const raw = store.readSource(artifact.id, artifact.filename);
      const isText = /^(text\/|application\/(json|xml))/.test(artifact.mimeType);
      return {
        contents: [
          isText
            ? { uri: uri.href, mimeType: artifact.mimeType, text: raw.toString("utf8") }
            : { uri: uri.href, mimeType: artifact.mimeType, blob: raw.toString("base64") },
        ],
      };
    }
  );

  return mcp;
}

function errorResult(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}
