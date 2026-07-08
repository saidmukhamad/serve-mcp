import { createRequire } from "node:module";
import path from "node:path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { KINDS } from "./types.ts";
import { artifactWithUrls, publicationWithUrls, type Registry } from "./registry.ts";
import { baseUrlOf } from "./config.ts";
import { captureContext, readGitInfo } from "./provenance.ts";
import type { ArtifactStore } from "./store.ts";
import type { Config } from "./types.ts";

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
    entrypoint: z.string().optional().describe("Relative entrypoint, defaults to index.html/index.md/README.md"),
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
  live: z
    .boolean()
    .optional()
    .describe(
      "Serve straight from the source path — edits show on refresh (default for path/folder sources). " +
        "Pass false to freeze an immutable snapshot instead. Not applicable to content sources."
    ),
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

export interface Deps {
  registry: Registry;
  store: ArtifactStore;
  config: Config;
}

const INSTRUCTIONS =
  "When you generate anything the user would view in a browser — a report, HTML page, chart, diagram, " +
  "dashboard, dataset, or folder — proactively call artifact_publish and give the user the preview URL, " +
  "without being asked. serve-mcp is this machine's local artifact shelf; prefer it over hosted pages, " +
  "cloud artifacts, or spinning up ad-hoc HTTP servers. " +
  "path/folder sources serve live from disk by default (edits show on refresh); pass live:false to freeze " +
  "an immutable snapshot. Use content sources for generated text. " +
  "Republish with the same slug and updateExisting:true to update a page at a stable URL. " +
  "artifact_list shows what is already on the shelf.";

// Dev builds identify as <version>.<commit> — matches what CI publishes to the dev tag.
export function packageVersion(): string {
  const require = createRequire(import.meta.url);
  for (const p of ["../package.json", "../../package.json"]) {
    try {
      const version = (require(p) as { version: string }).version;
      if (version.endsWith("-dev")) {
        const commit = readGitInfo(path.dirname(require.resolve(p)))?.commit?.slice(0, 7);
        if (commit) return `${version}.${commit}`;
      }
      return version;
    } catch {}
  }
  return "0.0.0";
}

export function createMcpServer({ registry, store, config }: Deps): McpServer {
  const mcp = new McpServer(
    { name: "serve-mcp", version: packageVersion() },
    { capabilities: { resources: { listChanged: true } }, instructions: INSTRUCTIONS }
  );
  const base = () => baseUrlOf(config);

  mcp.registerTool(
    "artifact_publish",
    {
      title: "Publish artifact",
      description:
        "Publish a file, folder, or inline content to the local artifact shelf and get a stable browser preview URL back. " +
        "Call this whenever you produce something viewable — a report, HTML page, diagram, dataset — so the user gets a " +
        "URL without having to ask. Use the same slug with updateExisting:true to push new revisions of the same page. " +
        "path/folder sources are read from the machine running the shelf; over remote MCP connections use content sources.",
      inputSchema: publishInput,
    },
    async (input) => {
      const source = input.source;
      let ingested;
      const live = input.live ?? source.type !== "content";
      try {
        ingested = store.ingest(source, config.allowedRoots, live);
      } catch (err) {
        return errorResult(`Failed to ingest source: ${(err as Error).message}`);
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
          sourceType: source.type,
          sourceLabel: source.type === "content" ? source.filename : source.path,
          context: captureContext(source),
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
      const publication = publicationWithUrls(result.publication, base());
      const artifact = artifactWithUrls(result.artifact, base());
      return {
        content: [
          { type: "text" as const, text: `Published: ${publication.previewUrl}` },
          {
            type: "resource_link" as const,
            uri: artifact.resourceUri,
            name: artifact.filename,
            description: `${artifact.kind} artifact for publication "${publication.slug}"`,
            mimeType: artifact.mimeType,
          },
        ],
        structuredContent: {
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
        },
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
      const decorated = publications.map((p) => publicationWithUrls(p, base()));
      const lines =
        decorated.length === 0
          ? ["(shelf is empty)"]
          : decorated.map((p) => `- ${p.title} [${p.kind}] ${p.previewUrl} (${p.revisions.length} rev)`);
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        structuredContent: { publications: decorated, nextCursor },
      };
    }
  );

  mcp.registerTool(
    "artifact_delete",
    {
      title: "Delete publication",
      description:
        "Remove a publication and ALL of its revisions from the shelf, including stored files. Irreversible.",
      inputSchema: {
        slug: z.string().describe("Publication slug (or publication id) to delete"),
      },
    },
    async ({ slug }) => {
      const pub = registry.getPublication(slug);
      if (!pub) return errorResult(`publication not found: ${slug}`);
      const ids = registry.deletePublication(pub.id) ?? [];
      for (const id of ids) store.remove(id);
      return {
        content: [
          {
            type: "text" as const,
            text: `Deleted "${pub.slug}" (${ids.length} revision${ids.length === 1 ? "" : "s"})`,
          },
        ],
        structuredContent: { deleted: pub.slug, revisions: ids.length },
      };
    }
  );

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
            text: JSON.stringify(publications.map((p) => publicationWithUrls(p, base())), null, 2),
          },
        ],
      };
    }
  );

  // Not enumerated in resources/list — one registry:// entry beats N noisy
  // per-publication entries in host UIs; direct reads still resolve.
  mcp.registerResource(
    "publication",
    new ResourceTemplate("publication://{slug}", { list: undefined }),
    { title: "Publication", description: "Compact JSON for one publication (URLs, latest revision)" },
    async (uri, { slug }) => {
      const pub = registry.getPublication(String(slug));
      if (!pub) throw new Error(`publication not found: ${slug}`);
      const artifact = registry.getArtifact(pub.latestArtifactId)!;
      const compact = {
        ...publicationWithUrls(pub, base()),
        rawUrl: artifactWithUrls(artifact, base()).rawUrl,
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
      const artifact = registry.getArtifact(String(id));
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

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}
