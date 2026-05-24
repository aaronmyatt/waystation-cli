// ──────────────────────────────────────────────────────────────────────────
// Bundled schema.sql as an exported string.
//
// JSR requires all exported modules to be valid TypeScript, so we wrap the
// raw SQL DDL in a string export. This is the programmatic accessor for
// consumers who want to apply the schema themselves (e.g. in tests or when
// managing the DB lifecycle outside `initDatabase`).
//
// The schema itself lives at ../schema.sql (the canonical DDL). This file
// is regenerated when schema.sql changes — keep them in sync.
//
// References:
//   • JSR restrictions on non-TS modules: https://jsr.io/docs/about#supported-files
//   • SQLite CREATE TABLE syntax: https://sqlite.org/lang_createtable.html
// ──────────────────────────────────────────────────────────────────────────

/** Canonical SQL DDL for the waystation database schema. */
export const SCHEMA_SQL: string = `

-- Table: flows
CREATE TABLE
  IF NOT EXISTS flows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    git_repo_root TEXT, -- path to the git repo root (optional)
    git_commit_sha TEXT, -- commit hash associated with this match
    git_branch TEXT, -- branch name (optional, for context)
    parent_flow_id INTEGER NULL, -- nullable for root flows, copied flows links to original flows
    parent_flow_match_id TEXT NULL, 
      -- nullable for root flows and copied flows, links to flow_match
      -- that was the source of the copy
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    archived BOOLEAN DEFAULT FALSE, -- indicates if the flow is archived
    local_only BOOLEAN DEFAULT FALSE, -- indicates if the flow should never be synced to backend
    synced_at DATETIME -- timestamp when flow was last synced (nullable)
  );

-- Table: matches
CREATE TABLE
  IF NOT EXISTS matches (
    id TEXT PRIMARY KEY,
    line TEXT NOT NULL,
    file_path TEXT NOT NULL,
    repo_relative_file_path TEXT NOT NULL,
    file_name TEXT NOT NULL,
    line_no INTEGER NOT NULL, -- stores the line number in the file
    grep_meta TEXT, -- stores grep metadata as JSON
    git_repo_root TEXT, -- path to the git repo root (optional)
    git_commit_sha TEXT, -- commit hash associated with this match
    git_branch TEXT, -- branch name (optional, for context)
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    archived BOOLEAN DEFAULT FALSE -- indicates if the flow is archived
  );

-- Add unique constraint to prevent duplicate matches in same location
-- will allow multiple flows to use the same data
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_match_location ON matches (line, file_path, git_commit_sha);

-- Table: flow_matches
CREATE TABLE
  IF NOT EXISTS flow_matches (
    id TEXT PRIMARY KEY,
    flows_id TEXT NOT NULL,
    matches_id TEXT,
    order_index INTEGER DEFAULT 0, -- tracks order within the flow
    content_kind TEXT NOT NULL, -- 'match' | 'note' | 'image' | 'html' | 'link' | ...
    content_id TEXT, -- ID of the content (matches.id or step_contents.id)
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    archived BOOLEAN DEFAULT FALSE, -- indicates if the flow is archived
    FOREIGN KEY (flows_id) REFERENCES flows (id),
    FOREIGN KEY (matches_id) REFERENCES matches (id)
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_position_in_flow ON flow_matches (flows_id, matches_id, order_index);

-- Table: step_contents
CREATE TABLE
  IF NOT EXISTS step_contents (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL, -- match | note | image | html | link
    title TEXT,
    body TEXT, -- optional: sanitized HTML / markdown
    file_path TEXT, -- optional: absolute path on disk
    blob_data BLOB, -- optional: store image bytes
    mime_type TEXT,
    original_name TEXT,
    meta_json TEXT, -- freeform metadata JSON
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

CREATE INDEX IF NOT EXISTS idx_step_contents_kind ON step_contents (kind);
CREATE INDEX IF NOT EXISTS idx_flow_matches_content ON flow_matches (content_kind, content_id);

-- Table: flow_history
CREATE TABLE
  IF NOT EXISTS flow_history (
    id TEXT PRIMARY KEY,
    flow_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (flow_id) REFERENCES flows (id)
  );

CREATE TABLE IF NOT EXISTS "tags" (
    id TEXT PRIMARY KEY,
    "name" varchar NOT NULL,
    "slug" varchar NOT NULL,
    "created_at" datetime DEFAULT CURRENT_TIMESTAMP,
    "updated_at" datetime DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "uniq_tags_name_user_team" UNIQUE ("name")
  );

CREATE TABLE IF NOT EXISTS "flow_tags" (
    id TEXT PRIMARY KEY,
    "flow_id" varchar(36) NOT NULL,
    "tag_id" varchar(36) NOT NULL,
    "created_at" datetime DEFAULT CURRENT_TIMESTAMP,
    "updated_at" datetime DEFAULT CURRENT_TIMESTAMP,
    "color" varchar DEFAULT '#6366f1',
    CONSTRAINT "fk_rails_efa80d918f" FOREIGN KEY ("flow_id") REFERENCES "flows" ("id"),
    CONSTRAINT "fk_rails_e2417908b1" FOREIGN KEY ("tag_id") REFERENCES "tags" ("id")
  );

CREATE INDEX IF NOT EXISTS "index_flow_tags_on_flow_id" ON "flow_tags" ("flow_id");
CREATE INDEX IF NOT EXISTS "index_flow_tags_on_tag_id" ON "flow_tags" ("tag_id");
CREATE UNIQUE INDEX IF NOT EXISTS "index_flow_tags_on_flow_id_and_tag_id" ON "flow_tags" ("flow_id", "tag_id");

CREATE TABLE IF NOT EXISTS "user_favourite_tags" (
    id TEXT PRIMARY KEY,
    "tag_id" varchar(36) NOT NULL,
    "created_at" datetime DEFAULT CURRENT_TIMESTAMP,
    "updated_at" datetime DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "fk_rails_feb86e68fc" FOREIGN KEY ("tag_id") REFERENCES "tags" ("id")
  );

CREATE UNIQUE INDEX IF NOT EXISTS "index_user_favourite_tags_on_tag_id" ON "user_favourite_tags" ("tag_id");
`;
