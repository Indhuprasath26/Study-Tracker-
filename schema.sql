BEGIN IMMEDIATE;

CREATE TABLE IF NOT EXISTS domains (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS technologies (
    id INTEGER PRIMARY KEY,
    domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    category TEXT,
    sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
    UNIQUE (domain_id, name)
);

CREATE TABLE IF NOT EXISTS technology_targets (
    technology_id INTEGER PRIMARY KEY REFERENCES technologies(id) ON DELETE CASCADE,
    target_hours REAL NOT NULL CHECK (target_hours > 0 AND target_hours <= 24)
);

CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY,
    domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE RESTRICT,
    technology_id INTEGER REFERENCES technologies(id) ON DELETE SET NULL,
    date TEXT NOT NULL
        CHECK (date(date) IS NOT NULL AND date(date) = date),
    is_college_day INTEGER NOT NULL DEFAULT 0
        CHECK (is_college_day IN (0, 1)),
    started_at TEXT NOT NULL,
    ended_at TEXT,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'paused', 'completed')),
    total_study_seconds INTEGER NOT NULL DEFAULT 0
        CHECK (total_study_seconds >= 0),
    total_pause_seconds INTEGER NOT NULL DEFAULT 0
        CHECK (total_pause_seconds >= 0),
    notes TEXT,
    CHECK (
        (status = 'completed' AND ended_at IS NOT NULL)
        OR (status IN ('active', 'paused') AND ended_at IS NULL)
    )
);

CREATE TABLE IF NOT EXISTS session_events (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
    event_type TEXT NOT NULL
        CHECK (event_type IN ('LOGIN', 'PAUSE', 'RESUME', 'LOGOFF')),
    event_time TEXT NOT NULL
        CHECK (
            substr(event_time, -1) = 'Z'
            AND strftime('%Y-%m-%dT%H:%M:%fZ', event_time) IS NOT NULL
        ),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        CHECK (substr(created_at, -1) = 'Z')
);

CREATE TABLE IF NOT EXISTS daily_goals (
    domain_id INTEGER PRIMARY KEY REFERENCES domains(id) ON DELETE RESTRICT,
    target_seconds INTEGER NOT NULL CHECK (target_seconds > 0)
);

CREATE TABLE IF NOT EXISTS coding_profiles (
    id INTEGER PRIMARY KEY,
    platform TEXT NOT NULL UNIQUE CHECK (platform IN ('leetcode', 'hackerrank')),
    username TEXT NOT NULL,
    last_synced_at TEXT,
    profile_url TEXT,
    last_checked_at TEXT,
    last_sync_error TEXT,
    pending_notification TEXT
);

CREATE TABLE IF NOT EXISTS coding_stats_snapshot (
    id INTEGER PRIMARY KEY,
    platform TEXT NOT NULL CHECK (platform IN ('leetcode', 'hackerrank')),
    total_solved INTEGER NOT NULL DEFAULT 0 CHECK (total_solved >= 0),
    easy_solved INTEGER NOT NULL DEFAULT 0 CHECK (easy_solved >= 0),
    medium_solved INTEGER NOT NULL DEFAULT 0 CHECK (medium_solved >= 0),
    hard_solved INTEGER NOT NULL DEFAULT 0 CHECK (hard_solved >= 0),
    global_rank INTEGER CHECK (global_rank IS NULL OR global_rank >= 0),
    extra_json TEXT NOT NULL DEFAULT '{}',
    fetched_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(date);
CREATE INDEX IF NOT EXISTS idx_coding_stats_snapshot_latest
    ON coding_stats_snapshot(platform, fetched_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_session_events_session_id
    ON session_events(session_id);
CREATE INDEX IF NOT EXISTS idx_session_events_session_time
    ON session_events(session_id, event_time, id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_only_one_open_session
    ON sessions((1))
    WHERE status IN ('active', 'paused');

CREATE TRIGGER IF NOT EXISTS session_events_no_update
BEFORE UPDATE ON session_events
BEGIN
    SELECT RAISE(ABORT, 'session_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS session_events_no_delete
BEFORE DELETE ON session_events
BEGIN
    SELECT RAISE(ABORT, 'session_events is append-only');
END;

INSERT INTO domains (name)
VALUES ('Data Analyst'), ('SDE'), ('Aptitude'), ('DSA')
ON CONFLICT(name) DO NOTHING;

COMMIT;