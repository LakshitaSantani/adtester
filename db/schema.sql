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

-- ================================================================ phase 4.5
-- Importing from tools that already hold real data.
--
-- The point of this table is to stop waiting. A customer's PostHog account
-- has months of real recordings from real users; borrowing them lets the
-- brain be tested today instead of after a fortnight of collecting our own.

CREATE TABLE IF NOT EXISTS data_sources (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,        -- posthog | notion | transcripts
  -- Host, remote project id, credentials. Shape depends on `kind`.
  config         JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at TIMESTAMPTZ,
  last_error     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, kind)
);

-- Where a session came from, so imported and self-recorded sessions can live
-- side by side and be told apart.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'sdk';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS external_id TEXT;

CREATE INDEX IF NOT EXISTS sessions_external
  ON sessions (project_id, source, external_id);

-- Order of a chunk inside its document.
--
-- For a transcript this is turn order, and it is what lets a match pull in
-- the turns around it. The decisive line in a meeting is usually the REPLY to
-- the one that matched keywords -- somebody raises a concern using the words
-- from the code, and the answer that overrules them shares none of them.
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS position INTEGER NOT NULL DEFAULT 0;

-- The second link. `view_token` reads; `admin_token` also configures and
-- spends. Nullable so projects created before the split keep working -- see
-- resolveProject, which treats a missing admin token as "the view token still
-- has its old powers".
ALTER TABLE projects ADD COLUMN IF NOT EXISTS admin_token TEXT UNIQUE;

-- Which page each signature actually fired on.
--
-- `signatures` says WHAT went wrong; this says WHERE. In a single-page app the
-- entry URL is usually not the page that broke -- somebody lands on the
-- homepage and clicks through to checkout -- so reasoning from entry_url makes
-- the whole pipeline examine the wrong page's code.
--
-- Shape: {"field_retry": ["/checkout"], "rage_click": ["/cart", "/search"]}
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS signature_paths JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Every page a session visited.
--
-- signature_paths gives the numerator for a rate (who broke, and where). This
-- gives the denominator (who was on the page at all). Without it a single-page
-- app has no measurable rate on any page except the one people landed on,
-- because everyone who did not break leaves no trace of having been there.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS paths TEXT[] NOT NULL DEFAULT '{}';

-- ================================================================ context
-- What the company is, so downstream judgement is possible at all.
--
-- Drafted from what's already connected -- the codebase says what the product
-- does, PRDs say what it's for -- and then CONFIRMED by a person. Inference
-- alone is confidently wrong in ways nobody sees; a blank form is tedious
-- enough that it gets skipped. A draft someone corrects is neither.
--
-- `drafted` keeps what we guessed alongside what they said, so a wrong guess
-- is visible rather than silently overwritten.
CREATE TABLE IF NOT EXISTS company_profile (
  project_id     TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  what_we_do     TEXT,
  customers      TEXT,          -- b2b | b2c | both
  revenue_model  TEXT,          -- subscription | transaction | ads | one_off | other
  -- The journeys that actually matter. A problem on checkout outranks a
  -- bigger one on /help, and without this they look identical.
  critical_paths TEXT[] NOT NULL DEFAULT '{}',
  -- Decides whether the counterfactual can ever be available, so it is worth
  -- knowing before someone waits a week for a capped answer.
  rollout        TEXT,          -- gradual | all_at_once | unsure
  competitors    TEXT[] NOT NULL DEFAULT '{}',
  seasonality    TEXT,
  drafted        JSONB NOT NULL DEFAULT '{}'::jsonb,
  confirmed_at   TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ================================================================ market
-- What changed outside the repository.
--
-- Everything else in this system rests on the counterfactual: compare people
-- who got a change against people who didn't. There is no such comparison for
-- "a competitor cut their price" -- you cannot A/B test the market, and no
-- amount of data will ever produce a control group.
--
-- So these are stored as OBSERVATIONS, never as scored causes. Each one needs
-- a date and a URL a person can open, because the only thing that makes this
-- worth showing is that a reader can check it themselves. Anything without
-- both is dropped rather than softened with a hedge.
CREATE TABLE IF NOT EXISTS market_events (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  competitor   TEXT NOT NULL,
  kind         TEXT NOT NULL,        -- pricing | launch | feature | funding | other
  occurred_on  DATE NOT NULL,
  headline     TEXT NOT NULL,
  detail       TEXT,
  url          TEXT NOT NULL,
  -- Whether the date came from the source itself or was inferred from when it
  -- was found. An inferred date can be weeks out, which matters when the whole
  -- value is "this happened just before your numbers moved".
  date_exact   BOOLEAN NOT NULL DEFAULT true,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, competitor, occurred_on, headline)
);

CREATE INDEX IF NOT EXISTS market_events_when
  ON market_events (project_id, occurred_on DESC);

-- Endpoints a session called that failed.
--
-- The only thread from a session back to server-side code. A page reaches its
-- own files through imports; a backend handler is only ever reached over the
-- network, so without this a Python or Go regression is invisible no matter
-- how well the repository is indexed.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS api_paths TEXT[] NOT NULL DEFAULT '{}';

-- Which commits each commit descends from.
--
-- Without this, "does this build contain that change?" can only be answered
-- from timestamps, which assumes history is a line. It isn't: a cherry-pick
-- puts a change into a build whose commit is older than the change, and a
-- rollback re-serves a build that timestamps say came later. Both make the
-- counterfactual compare the wrong two groups and report the result with
-- full confidence.
--
-- Costs nothing to collect: the sync already fetches each commit's detail for
-- its file list, and the parents are in the same response.
ALTER TABLE commits ADD COLUMN IF NOT EXISTS parents TEXT[] NOT NULL DEFAULT '{}';

-- Competitors the product went and found, rather than ones somebody typed in.
--
-- Kept apart from company_profile.competitors deliberately. That column is
-- what the market research actually searches, and it should only ever hold
-- names a person agreed to. A suggested name that quietly promoted itself
-- would spend the next month's research budget on a company that may have
-- nothing to do with this business, and file the results beside real
-- findings.
--
-- Dismissed rows are kept, not deleted, so the same company is not proposed
-- again every time discovery runs.
CREATE TABLE IF NOT EXISTS competitor_suggestions (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'established',  -- established | emerging
  because    TEXT NOT NULL,
  -- Required. A competitor without a source is a guess wearing a fact's
  -- clothing, and the screening drops it.
  url        TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'proposed',     -- proposed | accepted | dismissed
  found_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  UNIQUE (project_id, name)
);

CREATE INDEX IF NOT EXISTS competitor_suggestions_pending
  ON competitor_suggestions (project_id, status);

-- ------------------------------------------------------------------ slack

-- Which channels to read, and how far each has been read.
--
-- The watermark is what stops the product asking anyone for a date. A first
-- sync reaches back as far as the engine can still use (see window.ts); every
-- sync after that resumes from here, minus an overlap, because a thread keeps
-- gaining replies after we first read it and the reply is usually the
-- decision.
--
-- Channels are listed whether or not they are enabled, so setup can show the
-- workspace and let someone tick the ones worth reading rather than asking
-- for channel IDs.
CREATE TABLE IF NOT EXISTS slack_channels (
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  channel_id     TEXT NOT NULL,
  name           TEXT NOT NULL,
  is_private     BOOLEAN NOT NULL DEFAULT false,
  members        INTEGER NOT NULL DEFAULT 0,
  -- Nothing is read until somebody says so. A workspace has channels nobody
  -- would want indexed, and the default has to be the quiet one.
  enabled        BOOLEAN NOT NULL DEFAULT false,
  -- The newest message timestamp successfully ingested from this channel.
  last_ts        TEXT,
  last_synced_at TIMESTAMPTZ,
  last_error     TEXT,
  PRIMARY KEY (project_id, channel_id)
);

CREATE INDEX IF NOT EXISTS slack_channels_enabled
  ON slack_channels (project_id, enabled);


-- A connector-fetched document is identified by its address, not its title.
-- Two Slack threads in one channel on one day produce the same title, and
-- matching on that would have one replace the other silently.
CREATE INDEX IF NOT EXISTS documents_url
  ON documents (project_id, url);

-- ------------------------------------------------------------------ linear

-- The "commits" table for a team with no repository: issues, and the moment
-- each one shipped.
--
-- moved_to_completed_at is not completedAt from Linear's own API. completedAt
-- is when the issue itself was marked complete, which is a property of the
-- issue; moved_to_completed_at is read from that issue's history as the
-- createdAt of the specific transition into a "completed"-type state, which
-- is what actually happened at that moment and is what the counterfactual
-- splits users on. They usually agree. When an issue is reopened and
-- recompleted, or moved through several states quickly, they can differ by
-- more than rounding — and the history entry is the one that is true of the
-- moment being investigated.
--
-- state_type is Linear's own classification (triage, backlog, unstarted,
-- started, completed, canceled, duplicate) captured at sync time. Only
-- "completed" issues are candidates for having shipped something; the others
-- are kept so a report can say what an issue was doing instead, the way the
-- git product lists every commit in the window even ones that touched
-- nothing relevant.
CREATE TABLE IF NOT EXISTS linear_issues (
  id                    TEXT NOT NULL,
  project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  identifier            TEXT NOT NULL,       -- "ENG-482", what a person recognises
  title                 TEXT NOT NULL,
  description           TEXT,
  state_type            TEXT NOT NULL,
  moved_to_completed_at TIMESTAMPTZ,
  created_at            TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ,
  team_key              TEXT,
  labels                TEXT[] NOT NULL DEFAULT '{}',
  assignee              TEXT,
  url                   TEXT,
  PRIMARY KEY (project_id, id)
);

CREATE INDEX IF NOT EXISTS linear_issues_completed
  ON linear_issues (project_id, moved_to_completed_at DESC);

-- Per-project watermark for the issue sync. A project rather than a channel,
-- because unlike Slack there is one workspace and one meaningful stream of
-- issues to page through — nothing here is opted in or out per team the way
-- a Slack channel is per conversation.
CREATE TABLE IF NOT EXISTS linear_sync_state (
  project_id     TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  last_synced_at TIMESTAMPTZ,
  last_error     TEXT
);
