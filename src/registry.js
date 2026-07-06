import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Registry: publications (stable slugs) -> artifact revisions (immutable).
 * SQLite in WAL mode so several serve-mcp processes (one per agent) can
 * share one data dir safely.
 */
export class Registry {
  constructor(dataDir) {
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
        renderer_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY(publication_id) REFERENCES publications(id)
      );
      CREATE INDEX IF NOT EXISTS idx_artifacts_pub ON artifacts(publication_id, created_at);
    `);
  }

  /**
   * Record an ingested artifact under a publication slot.
   * Conflict rules (spec §13): explicit existing slug requires updateExisting;
   * generated slugs are made unique instead.
   */
  publish({ ingested, title, description, slug, updateExisting = false, tags = [], renderer = {}, sourceType, sourceLabel }) {
    const now = new Date().toISOString();
    const explicitSlug = Boolean(slug);
    let finalSlug = slugify(slug ?? title ?? ingested.filename);

    let pub = this.getPublication(finalSlug);
    if (pub && explicitSlug && !updateExisting) {
      const err = new Error(
        `publication "${finalSlug}" already exists; pass updateExisting: true to add a revision, or choose another slug`
      );
      err.code = "SLUG_CONFLICT";
      throw err;
    }
    if (pub && !explicitSlug) {
      finalSlug = this.#uniqueSlug(finalSlug);
      pub = null;
    }

    const artifactTitle = title ?? pub?.title ?? ingested.filename;

    let pubId;
    if (pub) {
      pubId = pub.id;
      this.db
        .prepare(`UPDATE publications SET latest_artifact_id = ?, updated_at = ?, title = ?, description = COALESCE(?, description), tags_json = ? WHERE id = ?`)
        .run(ingested.id, now, artifactTitle, description ?? null, JSON.stringify(mergeTags(pub.tags, tags)), pub.id);
    } else {
      pubId = `pub_${randomBytes(9).toString("base64url")}`;
      this.db
        .prepare(
          `INSERT INTO publications (id, slug, title, description, latest_artifact_id, tags_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(pubId, finalSlug, artifactTitle, description ?? null, ingested.id, JSON.stringify(tags), now, now);
    }

    this.db
      .prepare(
        `INSERT INTO artifacts (id, publication_id, kind, mime_type, sha256, title, filename, size_bytes, source_type, source_label, renderer_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        ingested.id,
        pubId,
        ingested.kind,
        ingested.mimeType,
        ingested.sha256,
        artifactTitle,
        ingested.filename,
        ingested.sizeBytes,
        sourceType,
        sourceLabel ?? null,
        JSON.stringify(renderer ?? {}),
        now
      );

    return {
      publication: this.getPublication(finalSlug),
      artifact: this.getArtifact(ingested.id),
    };
  }

  #uniqueSlug(base) {
    for (let i = 2; ; i++) {
      const candidate = `${base}-${i}`;
      if (!this.getPublication(candidate)) return candidate;
    }
  }

  /** Fetch by slug or publication id. */
  getPublication(slugOrId) {
    const row = this.db
      .prepare(`SELECT * FROM publications WHERE slug = ? OR id = ?`)
      .get(slugOrId, slugOrId);
    return row ? pubFromRow(row, this.#revisionIds(row.id)) : null;
  }

  getArtifact(id) {
    const row = this.db.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(id);
    return row ? artifactFromRow(row) : null;
  }

  #revisionIds(pubId) {
    return this.db
      .prepare(`SELECT id FROM artifacts WHERE publication_id = ? ORDER BY created_at ASC`)
      .all(pubId)
      .map((r) => r.id);
  }

  listPublications({ query, tags, kind, limit = 50, cursor, orderBy = "updatedAt", order = "desc" } = {}) {
    const cols = { createdAt: "p.created_at", updatedAt: "p.updated_at", title: "p.title" };
    const col = cols[orderBy] ?? cols.updatedAt;
    const dir = order === "asc" ? "ASC" : "DESC";
    const offset = cursor ? Number(cursor) || 0 : 0;

    const where = [];
    const params = [];
    if (query) {
      where.push(`(p.title LIKE ? OR p.slug LIKE ? OR p.description LIKE ?)`);
      const like = `%${query}%`;
      params.push(like, like, like);
    }
    if (kind?.length) {
      where.push(`a.kind IN (${kind.map(() => "?").join(",")})`);
      params.push(...kind);
    }

    const rows = this.db
      .prepare(
        `SELECT p.*, a.kind AS latest_kind FROM publications p
         JOIN artifacts a ON a.id = p.latest_artifact_id
         ${where.length ? "WHERE " + where.join(" AND ") : ""}
         ORDER BY p.pinned DESC, ${col} ${dir} LIMIT ? OFFSET ?`
      )
      .all(...params, limit + 1, offset);

    let out = rows.map((r) => ({ ...pubFromRow(r, this.#revisionIds(r.id)), kind: r.latest_kind }));
    if (tags?.length) out = out.filter((p) => tags.every((t) => p.tags.includes(t)));

    const hasMore = out.length > limit;
    return {
      publications: out.slice(0, limit),
      nextCursor: hasMore ? String(offset + limit) : undefined,
    };
  }

  close() {
    this.db.close();
  }
}

export function slugify(text) {
  const slug = String(text)
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || `pub-${randomBytes(4).toString("hex")}`;
}

function mergeTags(a, b) {
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}

function pubFromRow(row, revisions) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description ?? undefined,
    latestArtifactId: row.latest_artifact_id,
    revisions,
    tags: JSON.parse(row.tags_json),
    pinned: Boolean(row.pinned),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function artifactFromRow(row) {
  return {
    id: row.id,
    publicationId: row.publication_id,
    kind: row.kind,
    mimeType: row.mime_type,
    sha256: row.sha256,
    title: row.title,
    filename: row.filename,
    sizeBytes: row.size_bytes,
    source: { type: row.source_type, label: row.source_label ?? undefined },
    renderer: JSON.parse(row.renderer_json),
    createdAt: row.created_at,
  };
}

/** Attach human/mcp URLs to registry objects (spec §3). */
export function withUrls(obj, baseUrl, type) {
  if (!obj) return obj;
  if (type === "publication") {
    return {
      ...obj,
      previewUrl: `${baseUrl}/p/${obj.slug}`,
      resourceUri: `publication://${obj.slug}`,
    };
  }
  return {
    ...obj,
    previewUrl: `${baseUrl}/frame/${obj.id}`,
    rawUrl: `${baseUrl}/raw/${obj.id}`,
    resourceUri: `artifact://${obj.id}`,
  };
}
