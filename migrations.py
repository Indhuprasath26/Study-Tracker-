import sqlite3
from pathlib import Path


TECHNOLOGY_SEEDS = {
    "Data Analyst": [
        ("Excel", None),
        ("SQL", None),
        ("Python - Pandas", None),
        ("Python - NumPy", None),
        ("Matplotlib & Seaborn", None),
        ("Power BI", None),
        ("Tableau", None),
        ("Statistics", None),
        ("Project", None),
    ],
    "SDE": [
        ("JavaScript", "Frontend"),
        ("React", "Frontend"),
        ("Java", "Backend"),
        ("Spring Boot", "Backend"),
        ("MongoDB", "Backend"),
        ("Node.js", "Backend"),
        ("Express.js", "Backend"),
        ("Flask", "Backend"),
        ("Git & GitHub", None),
        ("OOPs", None),
        ("Project", None),
    ],
    "Aptitude": [
        ("Quantitative Aptitude", None),
        ("Logical Reasoning", None),
        ("Verbal Ability", None),
        ("Data Interpretation", None),
        ("Mock Tests", None),
    ],
    "DSA": [
        ("Time & Space Complexity", None),
        ("Arrays", None),
        ("Strings", None),
        ("Linked List", None),
        ("Stack & Queue", None),
        ("Recursion", None),
        ("Searching & Sorting", None),
        ("Trees", None),
        ("Graphs", None),
        ("Hashing", None),
        ("Greedy", None),
        ("Dynamic Programming", None),
        ("Backtracking", None),
        ("Sliding Window & Two Pointers", None),
        ("Problem Solving / Practice", None),
    ],
}


def migrate_database(connection: sqlite3.Connection) -> None:
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("BEGIN IMMEDIATE")
    try:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS technologies (
                id INTEGER PRIMARY KEY,
                domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                category TEXT,
                sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
                UNIQUE (domain_id, name)
            )
            """
        )
        technology_columns = {
            row["name"]
            for row in connection.execute("PRAGMA table_info(technologies)").fetchall()
        }
        if "category" not in technology_columns:
            connection.execute("ALTER TABLE technologies ADD COLUMN category TEXT")
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS technology_targets (
                technology_id INTEGER PRIMARY KEY REFERENCES technologies(id) ON DELETE CASCADE,
                target_hours REAL NOT NULL CHECK (target_hours > 0 AND target_hours <= 24)
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS coding_profiles (
                id INTEGER PRIMARY KEY,
                platform TEXT NOT NULL UNIQUE CHECK (platform IN ('leetcode', 'hackerrank')),
                username TEXT NOT NULL,
                last_synced_at TEXT,
                profile_url TEXT,
                last_checked_at TEXT,
                last_sync_error TEXT,
                pending_notification TEXT
            )
            """
        )
        coding_profile_columns = {
            row["name"]
            for row in connection.execute("PRAGMA table_info(coding_profiles)").fetchall()
        }
        for column_name in (
            "profile_url",
            "last_checked_at",
            "last_sync_error",
            "pending_notification",
        ):
            if column_name not in coding_profile_columns:
                connection.execute(f"ALTER TABLE coding_profiles ADD COLUMN {column_name} TEXT")
        connection.execute(
            """
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
            )
            """
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_coding_stats_snapshot_latest "
            "ON coding_stats_snapshot(platform, fetched_at DESC, id DESC)"
        )

        connection.executemany(
            "INSERT INTO domains (name) VALUES (?) ON CONFLICT(name) DO NOTHING",
            [(domain_name,) for domain_name in TECHNOLOGY_SEEDS],
        )

        session_columns = {
            row["name"]
            for row in connection.execute("PRAGMA table_info(sessions)").fetchall()
        }
        if "technology_id" not in session_columns:
            connection.execute(
                "ALTER TABLE sessions ADD COLUMN technology_id INTEGER "
                "REFERENCES technologies(id) ON DELETE SET NULL"
            )

        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_sessions_technology_id "
            "ON sessions(technology_id)"
        )

        for domain_name, technologies in TECHNOLOGY_SEEDS.items():
            domain = connection.execute(
                "SELECT id FROM domains WHERE name = ?", (domain_name,)
            ).fetchone()
            connection.executemany(
                "INSERT INTO technologies (domain_id, name, category, sort_order) VALUES (?, ?, ?, ?) "
                "ON CONFLICT(domain_id, name) DO UPDATE SET "
                "category = excluded.category, sort_order = excluded.sort_order",
                [
                    (domain["id"], technology_name, category, sort_order)
                    for sort_order, (technology_name, category) in enumerate(technologies)
                ],
            )

        sde_domain = connection.execute(
            "SELECT id FROM domains WHERE name = 'SDE'"
        ).fetchone()
        dsa_domain = connection.execute(
            "SELECT id FROM domains WHERE name = 'DSA'"
        ).fetchone()
        if sde_domain is not None and dsa_domain is not None:
            legacy_dsa = connection.execute(
                "SELECT id FROM technologies WHERE domain_id = ? AND name = 'DSA'",
                (sde_domain["id"],),
            ).fetchone()
            practice_topic = connection.execute(
                "SELECT id FROM technologies WHERE domain_id = ? "
                "AND name = 'Problem Solving / Practice'",
                (dsa_domain["id"],),
            ).fetchone()
            if legacy_dsa is not None and practice_topic is not None:
                connection.execute(
                    "UPDATE sessions SET domain_id = ?, technology_id = ? "
                    "WHERE domain_id = ? AND technology_id = ?",
                    (dsa_domain["id"], practice_topic["id"], sde_domain["id"], legacy_dsa["id"]),
                )
                connection.execute(
                    "INSERT INTO technology_targets(technology_id, target_hours) "
                    "SELECT ?, target_hours FROM technology_targets WHERE technology_id = ? "
                    "ON CONFLICT(technology_id) DO NOTHING",
                    (practice_topic["id"], legacy_dsa["id"]),
                )
                connection.execute(
                    "DELETE FROM technology_targets WHERE technology_id = ?",
                    (legacy_dsa["id"],),
                )
                connection.execute("DELETE FROM technologies WHERE id = ?", (legacy_dsa["id"],))

        connection.commit()
    except Exception:
        connection.rollback()
        raise


def migrate_path(database_path: Path) -> None:
    database_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(database_path) as connection:
        connection.row_factory = sqlite3.Row
        migrate_database(connection)