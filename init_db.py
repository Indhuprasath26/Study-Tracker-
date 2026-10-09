import argparse
import sqlite3
from pathlib import Path

from migrations import migrate_database


def initialize_database(database_path: Path) -> None:
    schema_path = Path(__file__).with_name("schema.sql")
    schema = schema_path.read_text(encoding="utf-8")
    database_path.parent.mkdir(parents=True, exist_ok=True)

    with sqlite3.connect(database_path) as connection:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.executescript(schema)
        migrate_database(connection)


def main() -> None:
    parser = argparse.ArgumentParser(description="Initialize the Study Time Tracker database.")
    parser.add_argument(
        "--database",
        type=Path,
        default=Path(__file__).with_name("study_tracker.db"),
        help="SQLite database path (default: study_tracker.db beside this script)",
    )
    args = parser.parse_args()

    initialize_database(args.database)
    print(f"Initialized database: {args.database}")


if __name__ == "__main__":
    main()