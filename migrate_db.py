import argparse
from pathlib import Path

from init_db import initialize_database
from migrations import migrate_path


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Safely add technologies and nullable session technology references."
    )
    parser.add_argument(
        "--database",
        type=Path,
        default=Path(__file__).with_name("study_tracker.db"),
        help="SQLite database path (default: study_tracker.db beside this script)",
    )
    args = parser.parse_args()

    if args.database.exists():
        migrate_path(args.database)
    else:
        initialize_database(args.database)
    print(f"Database migration complete: {args.database}")


if __name__ == "__main__":
    main()