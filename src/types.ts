export const KINDS = [
  "markdown",
  "mdx",
  "html",
  "image",
  "svg",
  "json",
  "csv",
  "text",
  "static-folder",
  "binary",
] as const;

export type ArtifactKind = (typeof KINDS)[number];

export type Source =
  | { type: "path"; path: string }
  | { type: "content"; content: string; filename?: string; mimeType?: string }
  | { type: "folder"; path: string; entrypoint?: string };

export interface RendererRef {
  name?: string;
  options?: { allowScripts?: boolean; [key: string]: unknown };
}

export interface Ingested {
  id: string;
  kind: ArtifactKind;
  mimeType: string;
  sha256: string;
  filename: string;
  sizeBytes: number;
}

export interface Artifact extends Ingested {
  publicationId: string;
  title: string;
  source: { type: Source["type"]; label?: string };
  renderer: RendererRef;
  createdAt: string;
}

export interface Publication {
  id: string;
  slug: string;
  title: string;
  description?: string;
  latestArtifactId: string;
  revisions: string[];
  tags: string[];
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  kind?: ArtifactKind;
}

export interface Config {
  host: string;
  /** null = ephemeral: the OS assigns a free port at bind time. */
  port: number | null;
  dataDir: string;
  /** null until a server binds or an existing one is discovered. */
  baseUrl: string | null;
}

export interface Rendered {
  body: string | Buffer;
  contentType: string;
}
