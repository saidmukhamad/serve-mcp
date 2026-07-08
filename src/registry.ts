import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Artifact, ArtifactKind, Ingested, Publication, RendererRef, Source, SourceContext } from "./types.ts";

export interface PublishParams {
  ingested: Ingested;
  title?: string;
  description?: string;
  slug?: string;
  updateExisting?: boolean;
  tags?: string[];
  renderer?: RendererRef;
  sourceType: Source["type"];
  sourceLabel?: string;
  context?: SourceContext;
}

export interface ListParams {
  query?: string;
  tags?: string[];
  kind?: ArtifactKind[];
  limit?: number;
  cursor?: string;
  orderBy?: "createdAt" | "updatedAt" | "title";
  order?: "asc" | "desc";
}

interface PublicationRow {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  latest_artifact_id: string;
  tags_json: string;
  pinned: number;
  created_at: string;
  updated_at: string;
  latest_kind?: string;
  latest_context?: string;
  latest_live?: number;
}

interface ArtifactRow {
  id: string;
  publication_id: string;
  kind: string;
  mime_type: string;
  sha256: string;
  title: string;
  filename: string;
  size_bytes: number;
  source_type: string;
  source_label: string | null;
  context_json: string | null;
  renderer_json: string;
  created_at: string;
  live: number;
}

// WAL so several serve-mcp processes (one per agent) can share one data dir.
export class Registry {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "registry.sqlite"));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS publications (
        id TEXT PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        latest_artifact_id TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        publication_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        title TEXT NOT NULL,
        filename TEXT NOT NULL,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        source_type TEXT NOT NULL,
        source_label TEXT,
        context_json TEXT NOT NULL DEFAULT '{}',
        renderer_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY(publication_id) REFERENCES publications(id)
      );
      CREATE INDEX IF NOT EXISTS idx_artifacts_pub ON artifacts(publication_id, created_at);
    `);
    for (const migration of [
      `ALTER TABLE artifacts ADD COLUMN context_json TEXT NOT NULL DEFAULT '{}'`,
      `ALTER TABLE artifacts ADD COLUMN live INTEGER NOT NULL DEFAULT 0`,
    ]) {
      try {
        this.db.exec(migration);
      } catch {
        // column already exists
      }
    }
  }

  private one<T>(sql: string, ...bind: (string | number | null)[]): T | undefined {
    return this.db.prepare(sql).get(...bind) as T | undefined;
  }

  private many<T>(sql: string, ...bind: (string | number | null)[]): T[] {
    return this.db.prepare(sql).all(...bind) as unknown as T[];
  }

  publish(params: PublishParams): { publication: Publication; artifact: Artifact } {
    const { ingested, description, updateExisting = false, tags = [], renderer = {}, sourceType, sourceLabel, context = {} } = params;
    const now = new Date().toISOString();
    const explicitSlug = Boolean(params.slug);
    let slug = slugify(params.slug ?? params.title ?? ingested.filename);

    let pub = this.getPublication(slug);
    if (pub && explicitSlug && !updateExisting) {
      const err = new Error(
        `publication "${slug}" already exists; pass updateExisting: true to add a revision, or choose another slug`
      ) as Error & { code: string };
      err.code = "SLUG_CONFLICT";
      throw err;
    }
    if (pub && !explicitSlug) {
      slug = this.uniqueSlug(slug);
      pub = null;
    }

    const title = params.title ?? pub?.title ?? ingested.filename;

    let pubId: string;
    if (pub) {
      pubId = pub.id;
      this.db
        .prepare(
          `UPDATE publications SET latest_artifact_id = ?, updated_at = ?, title = ?,
           description = COALESCE(?, description), tags_json = ? WHERE id = ?`
        )
        .run(ingested.id, now, title, description ?? null, JSON.stringify(mergeTags(pub.tags, tags)), pub.id);
    } else {
      pubId = `pub_${randomBytes(9).toString("base64url")}`;
      this.db
        .prepare(
          `INSERT INTO publications (id, slug, title, description, latest_artifact_id, tags_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(pubId, slug, title, description ?? null, ingested.id, JSON.stringify(tags), now, now);
    }

    this.db
      .prepare(
        `INSERT INTO artifacts (id, publication_id, kind, mime_type, sha256, title, filename, size_bytes,
         source_type, source_label, context_json, renderer_json, created_at, live)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        ingested.id,
        pubId,
        ingested.kind,
        ingested.mimeType,
        ingested.sha256,
        title,
        ingested.filename,
        ingested.sizeBytes,
        sourceType,
        sourceLabel ?? null,
        JSON.stringify(context),
        JSON.stringify(renderer),
        now,
        ingested.live ? 1 : 0
      );

    return {
      publication: this.getPublication(slug)!,
      artifact: this.getArtifact(ingested.id)!,
    };
  }

  private uniqueSlug(base: string): string {
    for (let i = 2; ; i++) {
      const candidate = `${base}-${i}`;
      if (!this.getPublication(candidate)) return candidate;
    }
  }

  getPublication(slugOrId: string): Publication | null {
    const row = this.one<PublicationRow>(
      `SELECT * FROM publications WHERE slug = ? OR id = ?`,
      slugOrId,
      slugOrId
    );
    return row ? this.pubFromRow(row) : null;
  }

  getArtifact(id: string): Artifact | null {
    const row = this.one<ArtifactRow>(`SELECT * FROM artifacts WHERE id = ?`, id);
    return row ? artifactFromRow(row) : null;
  }

  private revisionIds(pubId: string): string[] {
    return this.many<{ id: string }>(
      `SELECT id FROM artifacts WHERE publication_id = ? ORDER BY created_at ASC`,
      pubId
    ).map((r) => r.id);
  }

  listPublications(params: ListParams = {}): { publications: Publication[]; nextCursor?: string } {
    const { query, tags, kind, limit = 50, cursor, orderBy = "updatedAt", order = "desc" } = params;
    const cols = { createdAt: "p.created_at", updatedAt: "p.updated_at", title: "p.title" };
    const col = cols[orderBy] ?? cols.updatedAt;
    const dir = order === "asc" ? "ASC" : "DESC";
    const offset = cursor ? Number(cursor) || 0 : 0;

    const where: string[] = [];
    const bind: (string | number)[] = [];
    if (query) {
      where.push(`(p.title LIKE ? OR p.slug LIKE ? OR p.description LIKE ?)`);
      const like = `%${query}%`;
      bind.push(like, like, like);
    }
    if (kind?.length) {
      where.push(`a.kind IN (${kind.map(() => "?").join(",")})`);
      bind.push(...kind);
    }

    const rows = this.many<PublicationRow>(
      `SELECT p.*, a.kind AS latest_kind, a.context_json AS latest_context, a.live AS latest_live FROM publications p
       JOIN artifacts a ON a.id = p.latest_artifact_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY p.pinned DESC, ${col} ${dir} LIMIT ? OFFSET ?`,
      ...bind,
      limit + 1,
      offset
    );

    let out = rows.map((r) => this.pubFromRow(r));
    if (tags?.length) out = out.filter((p) => tags.every((t) => p.tags.includes(t)));

    const hasMore = out.length > limit;
    return {
      publications: out.slice(0, limit),
      nextCursor: hasMore ? String(offset + limit) : undefined,
    };
  }

  private pubFromRow(row: PublicationRow): Publication {
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      description: row.description ?? undefined,
      latestArtifactId: row.latest_artifact_id,
      revisions: this.revisionIds(row.id),
      tags: JSON.parse(row.tags_json),
      pinned: Boolean(row.pinned),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      kind: row.latest_kind as ArtifactKind | undefined,
      context: row.latest_context ? JSON.parse(row.latest_context) : undefined,
      live: Boolean(row.latest_live),
    };
  }

  /** Removes the publication and all its revisions; returns deleted artifact ids. */
  deletePublication(slugOrId: string): string[] | null {
    const pub = this.getPublication(slugOrId);
    if (!pub) return null;
    this.db.prepare(`DELETE FROM artifacts WHERE publication_id = ?`).run(pub.id);
    this.db.prepare(`DELETE FROM publications WHERE id = ?`).run(pub.id);
    return pub.revisions;
  }

  close(): void {
    this.db.close();
  }
}

export function slugify(text: string): string {
  const slug = String(text)
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || `pub-${randomBytes(4).toString("hex")}`;
}

function mergeTags(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

function artifactFromRow(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    publicationId: row.publication_id,
    kind: row.kind as ArtifactKind,
    mimeType: row.mime_type,
    sha256: row.sha256,
    title: row.title,
    filename: row.filename,
    sizeBytes: row.size_bytes,
    source: { type: row.source_type as Source["type"], label: row.source_label ?? undefined },
    context: JSON.parse(row.context_json ?? "{}"),
    renderer: JSON.parse(row.renderer_json),
    createdAt: row.created_at,
    live: Boolean(row.live),
  };
}

export function publicationWithUrls(pub: Publication, baseUrl: string) {
  return {
    ...pub,
    previewUrl: `${baseUrl}/p/${pub.slug}`,
    resourceUri: `publication://${pub.slug}`,
  };
}

export function artifactWithUrls(artifact: Artifact, baseUrl: string) {
  return {
    ...artifact,
    previewUrl: `${baseUrl}/frame/${artifact.id}`,
    rawUrl: `${baseUrl}/raw/${artifact.id}`,
    resourceUri: `artifact://${artifact.id}`,
  };
}
