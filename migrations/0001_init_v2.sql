-- ============================================================
-- Personal Agent OS — schema v2.0 baseline (migration 0001)
-- Complete baseline, executable against an empty database.
-- Target SQLite runtime >= 3.51.3 (WAL-reset fix, design §6.3 rule 6).
-- Enum CHECK constraints mirror packages/contracts/src/enums.ts
-- (single source of truth; CI drift check).
-- ============================================================
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------- 0. Migration ledger ----------
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  checksum   TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

-- ---------- 1. Installation & registry ----------
CREATE TABLE IF NOT EXISTS installation (
  id          TEXT PRIMARY KEY DEFAULT 'me',
  secret_hash TEXT NOT NULL,               -- installation_secret hash; plaintext only in OS keychain / 0600 file
  created_at  TEXT NOT NULL,
  rotated_at  TEXT
);

CREATE TABLE IF NOT EXISTS domain_packs (
  id           TEXT PRIMARY KEY,           -- work / career / learning / venture / life / investing
  version      TEXT NOT NULL,
  manifest_ref TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plugin_registry (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('agent-adapter','tool','domain-pack','skill-pack')),
  version       TEXT NOT NULL,
  source        TEXT NOT NULL CHECK (source IN ('builtin','reviewed','user-local')),
  manifest      TEXT NOT NULL,             -- JSON, validated against PluginManifest schema before write
  install_state TEXT NOT NULL CHECK (install_state IN ('inspected','trusted','enabled','disabled','revoked')),
  enabled       INTEGER NOT NULL DEFAULT 0,
  installed_at  TEXT NOT NULL,
  enabled_at    TEXT
);

CREATE TABLE IF NOT EXISTS adapter_capabilities (
  adapter_id TEXT NOT NULL REFERENCES plugin_registry(id) ON DELETE CASCADE,
  capability TEXT NOT NULL,
  declared   INTEGER NOT NULL DEFAULT 0,   -- manifest declaration
  enforced   INTEGER NOT NULL DEFAULT 0,   -- probed; only this column may drive hard security decisions
  unconfined INTEGER NOT NULL DEFAULT 0,   -- 1 = isolation cannot be enforced; no scope-restricted tasks
  detail     TEXT,
  PRIMARY KEY (adapter_id, capability)
);

-- ---------- 2. Goals / profile / projects / tasks ----------
CREATE TABLE IF NOT EXISTS goals (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  horizon         TEXT NOT NULL CHECK (horizon IN ('quarter','year','multi-year')),
  status          TEXT NOT NULL CHECK (status IN ('active','achieved','dropped')),
  success_measure TEXT NOT NULL,
  review_by       TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  id           TEXT PRIMARY KEY DEFAULT 'me',
  display_name TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profile_facts (
  id                   TEXT PRIMARY KEY,
  kind                 TEXT NOT NULL CHECK (kind IN ('identity','preference','constraint','skill','goal-link','other')),
  key                  TEXT NOT NULL,
  value                TEXT NOT NULL,
  origin_type          TEXT NOT NULL CHECK (origin_type IN ('user_confirmed','behavior_inferred','ai_observation','system_record','external_source')),
  source_ref           TEXT,
  created_by_run_id    TEXT,
  confidence           REAL NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
  confirmation_status  TEXT NOT NULL CHECK (confirmation_status IN ('tentative','stable','retracted')),
  confirmed_at         TEXT,
  review_by            TEXT NOT NULL,
  sensitivity          TEXT NOT NULL DEFAULT 'personal' CHECK (sensitivity IN ('public','personal','sensitive','secret')),
  deleted_at           TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_facts_key ON profile_facts(key) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS projects (
  id             TEXT PRIMARY KEY,
  domain         TEXT NOT NULL,
  goal_id        TEXT REFERENCES goals(id) ON DELETE SET NULL,
  title          TEXT NOT NULL,
  hypothesis     TEXT NOT NULL,
  stop_condition TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('active','paused','stopped','graduated')),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_domain ON projects(domain, status);

CREATE TABLE IF NOT EXISTS tasks (
  id                       TEXT PRIMARY KEY,
  domain                   TEXT NOT NULL,
  project_id               TEXT REFERENCES projects(id) ON DELETE SET NULL,
  goal_id                  TEXT REFERENCES goals(id) ON DELETE SET NULL,
  title                    TEXT NOT NULL,
  next_action              TEXT NOT NULL,
  done_condition           TEXT NOT NULL,
  status                   TEXT NOT NULL CHECK (status IN ('inbox','triaged','planned','ready','running','waiting_approval','cancel_requested','review_required','blocked','deferred','failed','done','cancelled','rejected')),
  risk                     TEXT NOT NULL CHECK (risk IN ('R0','R1','R2','R3','R4')),
  terminal_reason          TEXT,           -- required for terminal states
  waiting_on               TEXT,           -- external dependency (person/thing)
  estimate_min             INTEGER,
  actual_min               INTEGER,
  deferred_until           TEXT,
  evidence_refs            TEXT NOT NULL DEFAULT '[]',   -- JSON array; must be non-empty before done
  verification_report_ref  TEXT,           -- Verifier writes; required before done
  accepted_at              TEXT,           -- required before done
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_domain ON tasks(domain, status);

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id            TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL DEFAULT 'blocks',
  PRIMARY KEY (task_id, depends_on_task_id)
);

CREATE TABLE IF NOT EXISTS decisions (
  id            TEXT PRIMARY KEY,
  date          TEXT NOT NULL,
  domain        TEXT NOT NULL,
  situation     TEXT NOT NULL,
  options       TEXT NOT NULL,
  rationale     TEXT NOT NULL,
  outcome       TEXT NOT NULL,
  lesson        TEXT NOT NULL,
  review_by     TEXT NOT NULL,
  evidence_refs TEXT NOT NULL DEFAULT '[]',
  superseded_by TEXT
);

CREATE TABLE IF NOT EXISTS conflicts (
  id            TEXT PRIMARY KEY,
  topic         TEXT NOT NULL,
  claim_a_src   TEXT NOT NULL,
  claim_a_val   TEXT NOT NULL,
  claim_b_src   TEXT NOT NULL,
  claim_b_val   TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  resolved_at   TEXT
);

-- ---------- 3. Workflow runtime ----------
CREATE TABLE IF NOT EXISTS workflow_runs (
  id               TEXT PRIMARY KEY,
  workflow_id      TEXT NOT NULL,
  workflow_version TEXT NOT NULL,
  domain           TEXT NOT NULL,
  task_id          TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  status           TEXT NOT NULL CHECK (status IN ('planned','running','waiting_approval','cancel_requested','paused','unknown_outcome','succeeded','partial','failed','cancelled','reconciled')),
  terminal_reason  TEXT,
  code_version     TEXT NOT NULL,          -- frozen run snapshot, anti replay drift
  worker_id        TEXT,
  lease_until      TEXT,
  heartbeat_at     TEXT,
  input_ref        TEXT NOT NULL,          -- frozen run snapshot (contract + inputs)
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wfr_status ON workflow_runs(status, lease_until);

CREATE TABLE IF NOT EXISTS run_steps (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_run_id  TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id          TEXT NOT NULL,
  seq              INTEGER NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('note','agent-delegate','verify','approval','human-input')),
  skill_ref        TEXT,
  input_ref        TEXT,
  input_sha256     TEXT,
  output_ref       TEXT,
  output_sha256    TEXT,
  status           TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','skipped','cancelled')),
  attempt          INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 1,
  idempotency_key  TEXT,                   -- mandatory for side-effecting steps
  error_code       TEXT,
  error            TEXT,
  started_at       TEXT,
  ended_at         TEXT,
  UNIQUE (workflow_run_id, step_id)
);
CREATE INDEX IF NOT EXISTS idx_run_steps_run ON run_steps(workflow_run_id, status);

CREATE TABLE IF NOT EXISTS dispatch_intents (
  id                            TEXT PRIMARY KEY,
  workflow_run_id               TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id                       TEXT NOT NULL,
  adapter_id                    TEXT NOT NULL,
  provider                      TEXT NOT NULL,
  idempotency_key               TEXT NOT NULL,
  contract_hash                 TEXT NOT NULL,
  state                         TEXT NOT NULL CHECK (state IN ('pending','dispatching','accepted','rejected','unknown_outcome','reconciled')),
  supports_server_idempotency   INTEGER NOT NULL DEFAULT 0,  -- only measured-true adapters may auto-retry
  provider_task_id              TEXT,
  attempt_count                 INTEGER NOT NULL DEFAULT 0,
  last_error                    TEXT,
  dispatched_at                 TEXT,
  resolved_at                   TEXT,
  created_at                    TEXT NOT NULL,
  updated_at                    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_key ON dispatch_intents(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_dispatch_provider_task ON dispatch_intents(provider, provider_task_id);

CREATE TABLE IF NOT EXISTS run_events (
  event_id         INTEGER PRIMARY KEY AUTOINCREMENT,   -- SSE resume cursor
  workflow_run_id  TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  at               TEXT NOT NULL,
  event_type       TEXT NOT NULL,
  step_id          TEXT,
  payload_ref      TEXT,
  payload_sha256   TEXT,
  detail           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(workflow_run_id, event_id);

CREATE TABLE IF NOT EXISTS approvals (
  id                   TEXT PRIMARY KEY,
  workflow_run_id      TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id              TEXT NOT NULL,
  risk                 TEXT NOT NULL CHECK (risk IN ('R0','R1','R2','R3','R4')),
  action               TEXT NOT NULL,
  action_hash          TEXT NOT NULL,       -- sha256 of the exact action
  resource_scope_hash  TEXT NOT NULL,
  nonce                TEXT,                -- R3/R4 one-time random
  token                TEXT,                -- R4: explicit human confirmation token
  decision             TEXT NOT NULL CHECK (decision IN ('pending','approved','denied','expired','consumed','superseded')),
  decided_by           TEXT,
  decided_at           TEXT,
  consumed_at          TEXT,
  expires_at           TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_run ON approvals(workflow_run_id, step_id);

CREATE TABLE IF NOT EXISTS audit_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  at             TEXT NOT NULL,
  actor          TEXT NOT NULL,
  action         TEXT NOT NULL,
  target         TEXT,
  decision       TEXT NOT NULL,
  reason_code    TEXT,
  workflow_run_id TEXT,
  step_id        TEXT,
  approval_id    TEXT REFERENCES approvals(id),
  correlation_id TEXT,
  detail         TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_run ON audit_events(workflow_run_id, id);

-- append-only: UPDATE/DELETE triggers (design §12.4)
CREATE TRIGGER IF NOT EXISTS trg_audit_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only: UPDATE rejected');
END;

CREATE TRIGGER IF NOT EXISTS trg_audit_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only: DELETE rejected');
END;

-- ---------- 4. Artifacts / evidence / claims ----------
CREATE TABLE IF NOT EXISTS artifacts (
  id                  TEXT PRIMARY KEY,    -- opaque; API never exposes storage_path
  storage_path        TEXT NOT NULL,
  kind                TEXT NOT NULL,
  media_type          TEXT NOT NULL,
  bytes               INTEGER NOT NULL,
  sha256              TEXT NOT NULL,
  data_classification TEXT NOT NULL DEFAULT 'personal' CHECK (data_classification IN ('public','personal','sensitive','secret')),
  trust_level         TEXT NOT NULL DEFAULT 'system_generated' CHECK (trust_level IN ('user_provided','external_untrusted','agent_generated','system_generated')),
  source_run_id       TEXT,
  retention_policy    TEXT NOT NULL DEFAULT 'default',
  created_at          TEXT NOT NULL,
  deleted_at          TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_path ON artifacts(storage_path) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS evidence (
  id                  TEXT PRIMARY KEY,
  kind                TEXT NOT NULL CHECK (kind IN ('test-run','diff','interview','link','figure','document','log','external-response')),
  artifact_id         TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
  source_ref          TEXT,
  collected_by        TEXT NOT NULL,
  collected_by_run_id TEXT,
  summary             TEXT NOT NULL,
  observed_at         TEXT NOT NULL,
  sensitivity         TEXT NOT NULL DEFAULT 'personal',
  created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS claims (
  id                TEXT PRIMARY KEY,
  statement         TEXT NOT NULL,
  domain            TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('supported','contradicted','unverified','retracted')),
  created_by_run_id TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_claim_links (
  evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  claim_id    TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  relation    TEXT NOT NULL CHECK (relation IN ('supports','contradicts')),
  note        TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (evidence_id, claim_id)
);

CREATE TABLE IF NOT EXISTS memories (
  id                  TEXT PRIMARY KEY,
  layer               TEXT NOT NULL CHECK (layer IN ('profile','episodic','semantic','procedural','decision-evidence')),
  content             TEXT NOT NULL,
  origin_type         TEXT NOT NULL CHECK (origin_type IN ('user_confirmed','behavior_inferred','ai_observation','system_record','external_source')),
  source_ref          TEXT,
  created_by_run_id   TEXT,
  confidence          REAL NOT NULL DEFAULT 1.0,
  confirmation_status TEXT NOT NULL CHECK (confirmation_status IN ('tentative','stable','retracted')),
  confirmed_at        TEXT,
  review_by           TEXT NOT NULL,
  sensitivity         TEXT NOT NULL DEFAULT 'personal',
  deleted_at          TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_layer ON memories(layer, confirmation_status) WHERE deleted_at IS NULL;

-- ---------- 5. Evaluation ----------
CREATE TABLE IF NOT EXISTS eval_runs (
  id           TEXT PRIMARY KEY,
  workflow_id  TEXT NOT NULL,
  mode         TEXT NOT NULL CHECK (mode IN ('fixture','live')),
  case_count   INTEGER NOT NULL,
  passed       INTEGER NOT NULL,
  failed       INTEGER NOT NULL,
  report_ref   TEXT,
  cli_versions TEXT,                       -- live mode records CLI/model/platform versions
  created_at   TEXT NOT NULL
);
