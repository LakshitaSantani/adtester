-- Schema for the whole product. Phases 1–2 use the first three tables;
-- the rest are created now so the shape is settled and nothing needs a
-- painful migration later.
--
-- This is plain Postgres SQL and runs unchanged on PGlite (local, embedded)
-- and on any hosted Postgres. Only the `chunks.embedding` column needs the
-- pgvector extension, and that isn't touched until phase 5.

-- ---------------------------------------------------------------- projects

CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  -- Public. Goes in the script tag on the customer's site.
  install_key  TEXT NOT NULL UNIQUE,
  -- Secret. Whoever has this can read the recordings. Not real auth —
  -- see the note in the design doc. Replaced by accounts in phase 6.
  view_token   TEXT NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- outcome

CREATE TABLE IF NOT EXISTS sessions (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- THE join key. Without it a session is an anecdote; with it, a session
  -- can be compared against every session on a different build. Cannot be
  -- backfilled, which is why it is captured from the very first commit.
  release          TEXT,

  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_event_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at        TIMESTAMPTZ,
  close_reason     TEXT,

  entry_url        TEXT,
  referrer         TEXT,
  user_agent       TEXT,
  language         TEXT,
  time_zone        TEXT,
  viewport_width   INTEGER,
  viewport_height  INTEGER,

  -- Set by identify(), when the customer's app knows who this is.
  user_id          TEXT,
  user_email       TEXT,
  user_name        TEXT,

  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Denormalised counters, so the session list never reads the event files.
  event_count      INTEGER NOT NULL DEFAULT 0,
  byte_count       BIGINT  NOT NULL DEFAULT 0,

  -- Which signatures fired during this session: rage_click, dead_click,
  -- field_retry, js_error, network_error. This is what turns a pile of
  -- recordings into a short list worth watching.
  signatures       TEXT[] NOT NULL DEFAULT '{}',
  error_count      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS sessions_project_started
  ON sessions (project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS sessions_release
  ON sessions (project_id, release);
CREATE INDEX IF NOT EXISTS sessions_signatures
  ON sessions USING GIN (signatures);

-- ---------------------------------------------------------------- change

CREATE TABLE IF NOT EXISTS commits (
  sha           TEXT NOT NULL,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  authored_at   TIMESTAMPTZ,
  -- Matters far more than authored_at. Code merged Friday and deployed
  -- Tuesday cannot have broken anything on Monday.
  deployed_at   TIMESTAMPTZ,
  author        TEXT,
  message       TEXT,
  pr_number     INTEGER,
  pr_title      TEXT,
  pr_body       TEXT,
  files_touched TEXT[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (project_id, sha)
);

CREATE INDEX IF NOT EXISTS commits_deployed
  ON commits (project_id, deployed_at DESC);

-- ---------------------------------------------------------------- structure

-- The lexicon: the dictionary between how people talk in meetings and what
-- things are called in the repo. "phone field" -> PhoneInput.tsx.
CREATE TABLE IF NOT EXISTS code_entities (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  kind        TEXT NOT NULL,           -- route | component | function | flag
  name        TEXT NOT NULL,
  route       TEXT,                    -- the URL path this serves, if any
  aliases     TEXT[] NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS code_entities_project_route
  ON code_entities (project_id, route);

-- ---------------------------------------------------------------- intent

CREATE TABLE IF NOT EXISTS documents (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source      TEXT NOT NULL,           -- notion | gdocs | markdown | transcript
  title       TEXT,
  url         TEXT,
  occurred_at TIMESTAMPTZ,             -- when the meeting happened / doc revised
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chunks (
  id           TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  text         TEXT NOT NULL,
  speaker      TEXT,                   -- transcripts only
  occurred_at  TIMESTAMPTZ,
  offset_ms    INTEGER,                -- position in the recording, for deep links
  -- Phase 5. Needs: CREATE EXTENSION vector;
  -- embedding vector(1536),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chunks_project_time
  ON chunks (project_id, occurred_at DESC);

-- ---------------------------------------------------------------- output

CREATE TABLE IF NOT EXISTS investigations (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  symptom         TEXT NOT NULL,
  symptom_started TIMESTAMPTZ,
  status          TEXT NOT NULL,       -- queued | running | claimed | declined | failed
  claim           TEXT,
  commit_sha      TEXT,
  confidence      REAL,
  declined_reason TEXT,                -- no_version_split | tied_candidates | diffuse
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);

-- Evidence is stored as rows, never as generated prose. That is what lets an
-- old investigation be re-scored when the weights improve, and what lets the
-- UI show the breakdown behind a confidence number.
CREATE TABLE IF NOT EXISTS evidence (
  id               TEXT PRIMARY KEY,
  investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL,      -- session | commit | counterfactual | prd | transcript
  ref              TEXT,               -- session id, commit sha, chunk id
  quote            TEXT,               -- exact span, for anything inferred
  detail           JSONB NOT NULL DEFAULT '{}'::jsonb,
  contribution     REAL                -- how much this moved the confidence
);

CREATE TABLE IF NOT EXISTS feedback (
  investigation_id TEXT PRIMARY KEY REFERENCES investigations(id) ON DELETE CASCADE,
  was_correct      BOOLEAN NOT NULL,
  note             TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- jobs

-- The queue is a table. A worker claims rows and marks them done. No Redis,
-- no queue service, and a failed job is a row you can look at.
CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,
  project_id   TEXT REFERENCES projects(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | running | done | failed
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  run_after    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS jobs_pending
  ON jobs (status, run_after);

-- ================================================================ phase 3
-- Connecting the code: where commits come from, how the repo is wired, and
-- what a given URL actually reaches.

CREATE TABLE IF NOT EXISTS repos (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner          TEXT NOT NULL,
  name           TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  -- A personal access token pasted by the customer. Fine for design
  -- partners; becomes a GitHub App installation in phase 6, at which point
  -- this column holds an installation id instead.
  access_token   TEXT,
  last_synced_at TIMESTAMPTZ,
  last_error     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, owner, name)
);

-- The import graph, so we can answer "what code does this route reach?".
-- Directed: from_path imports to_path.
CREATE TABLE IF NOT EXISTS code_edges (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_path  TEXT NOT NULL,
  to_path    TEXT NOT NULL,
  PRIMARY KEY (project_id, from_path, to_path)
);

CREATE INDEX IF NOT EXISTS code_edges_from ON code_edges (project_id, from_path);

CREATE INDEX IF NOT EXISTS commits_sha_prefix ON commits (project_id, sha);
