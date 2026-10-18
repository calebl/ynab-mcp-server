-- Auto-budget service state. Applied with `wrangler d1 migrations apply`;
-- see DEPLOY.md.

-- Small key/value state: the pause flag, run lease, last digest date and
-- daily maintenance date.
CREATE TABLE state (
  plan_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (plan_id, key)
);

-- Delta-request cursors (`server_knowledge`), one per plan and resource.
CREATE TABLE sync_state (
  plan_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  server_knowledge INTEGER NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (plan_id, resource)
);

-- Mirror of the plan's transactions, kept current by delta sync. Amounts are
-- milliunits. Split details are stored as JSON on their parent transaction.
CREATE TABLE txn (
  id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  date TEXT NOT NULL,
  amount INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  payee_id TEXT,
  payee_name TEXT,
  category_id TEXT,
  approved INTEGER NOT NULL,
  cleared TEXT NOT NULL,
  flag_color TEXT,
  import_id TEXT,
  matched_transaction_id TEXT,
  transfer_account_id TEXT,
  split INTEGER NOT NULL,
  subtransactions TEXT NOT NULL,
  deleted INTEGER NOT NULL,
  PRIMARY KEY (plan_id, id)
);
CREATE INDEX txn_pending ON txn (plan_id, approved, deleted);
CREATE INDEX txn_payee ON txn (plan_id, payee_id, date);
CREATE INDEX txn_account ON txn (plan_id, account_id, amount, date);

-- Mirror of the plan's accounts, for on-budget status and import-link health.
CREATE TABLE account (
  id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  name TEXT NOT NULL,
  on_budget INTEGER NOT NULL,
  closed INTEGER NOT NULL,
  deleted INTEGER NOT NULL,
  direct_import_in_error INTEGER NOT NULL,
  PRIMARY KEY (plan_id, id)
);

-- One row per scheduled run.
CREATE TABLE run (
  id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  mode TEXT NOT NULL,
  outcome TEXT,
  error TEXT,
  calls_used INTEGER,
  summary TEXT,
  PRIMARY KEY (plan_id, id)
);

-- Audit log: every decision the service makes in shadow mode. A decision is
-- recorded again only when it changes (decision_key differs).
CREATE TABLE decision (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  source TEXT,
  detail TEXT NOT NULL,
  decision_key TEXT NOT NULL,
  mode TEXT NOT NULL,
  written INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX decision_subject ON decision (plan_id, stage, subject_id, id);
CREATE INDEX decision_created ON decision (plan_id, created_at);

-- Immediate alerts already delivered, so each fires once per period.
CREATE TABLE alert (
  plan_id TEXT NOT NULL,
  rule TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  period TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (plan_id, rule, subject_id, period)
);

-- Items waiting for the owner, and the before/after state needed to undo a
-- write. Both are filled by later write stages; shadow mode leaves them empty.
CREATE TABLE review_queue (
  plan_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  proposal TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT,
  PRIMARY KEY (plan_id, stage, subject_id)
);

CREATE TABLE undo (
  plan_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  before_state TEXT NOT NULL,
  after_state TEXT NOT NULL,
  undone_at TEXT,
  result TEXT,
  PRIMARY KEY (plan_id, run_id, subject_id, kind)
);
