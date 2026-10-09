import csv
import json
import math
import re
import sqlite3
import threading
import tempfile
from contextlib import closing
from datetime import date, datetime, timedelta, timezone
from io import StringIO
from pathlib import Path
from urllib.parse import unquote, urlsplit

import requests
from apscheduler.schedulers.background import BackgroundScheduler
from flask import Flask, jsonify, make_response, render_template, request, send_file

from database import get_connection
from init_db import initialize_database


LEETCODE_GRAPHQL_URL = "https://leetcode.com/graphql"
LEETCODE_STATS_QUERY = """query userProfile($username: String!) {
    allQuestionsCount {
        difficulty
        count
    }
  matchedUser(username: $username) {
    username
    profile {
      ranking
    }
    submitStats {
      acSubmissionNum {
        difficulty
        count
      }
    }
        languageProblemCount {
            languageName
            problemsSolved
        }
  }
}"""
coding_scheduler_lock = threading.Lock()
coding_sync_state_lock = threading.Lock()
coding_sync_locks = {"leetcode": threading.Lock()}
coding_syncs_in_progress = set()


class LeetCodeSyncError(Exception):
    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.status_code = status_code


def parse_leetcode_profile_url(profile_url: str) -> str:
    if not isinstance(profile_url, str):
        raise ValueError("Enter a LeetCode profile URL.")
    profile_url = profile_url.strip()
    try:
        parsed = urlsplit(profile_url)
        port = parsed.port
    except ValueError:
        raise ValueError("Enter a valid LeetCode profile URL.") from None
    if (
        parsed.scheme.lower() != "https"
        or parsed.hostname is None
        or parsed.hostname.lower() not in {"leetcode.com", "www.leetcode.com"}
        or parsed.username is not None
        or parsed.password is not None
        or port not in (None, 443)
    ):
        raise ValueError("Enter a public HTTPS LeetCode profile URL.")

    segments = [unquote(segment) for segment in parsed.path.split("/") if segment]
    if segments and segments[0].lower() == "u":
        segments = segments[1:]
    if not segments:
        raise ValueError("The LeetCode profile URL must include a username.")
    username = segments[0]
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", username):
        raise ValueError("The LeetCode profile URL has an invalid username path.")
    return username


def fetch_leetcode_stats(username: str) -> dict:
    username = username.strip() if isinstance(username, str) else ""
    if not username:
        raise LeetCodeSyncError("Enter a LeetCode username first.", 400)

    try:
        response = requests.post(
            LEETCODE_GRAPHQL_URL,
            json={
                "query": LEETCODE_STATS_QUERY,
                "variables": {"username": username},
            },
            headers={
                "Content-Type": "application/json",
                "Referer": f"https://leetcode.com/{username}/",
                "User-Agent": "StudyTimeTracker/1.0",
            },
            timeout=15,
        )
    except requests.Timeout as error:
        raise LeetCodeSyncError("LeetCode is taking too long to respond. Try again shortly.", 503) from error
    except requests.RequestException as error:
        raise LeetCodeSyncError("LeetCode is temporarily unavailable. Try again shortly.", 503) from error

    if response.status_code == 429:
        raise LeetCodeSyncError("LeetCode is rate limiting requests. Please try again later.", 429)
    if response.status_code >= 500:
        raise LeetCodeSyncError("LeetCode is temporarily unavailable. Try again shortly.", 503)
    if not response.ok:
        raise LeetCodeSyncError("LeetCode rejected the profile request. Check the username and try again.", 400)

    try:
        payload = response.json()
    except (ValueError, requests.RequestException) as error:
        raise LeetCodeSyncError("LeetCode returned an unreadable response. Try again later.") from error

    if not isinstance(payload, dict):
        raise LeetCodeSyncError("LeetCode returned an unreadable response. Try again later.")
    if payload.get("errors"):
        raise LeetCodeSyncError("LeetCode could not return public profile stats. Try again later.")
    data = payload.get("data")
    if not isinstance(data, dict):
        raise LeetCodeSyncError("LeetCode returned an unreadable response. Try again later.")
    matched_user = data.get("matchedUser")
    if matched_user is None:
        raise LeetCodeSyncError("That LeetCode username was not found or its profile is not public.", 404)
    if not isinstance(matched_user, dict):
        raise LeetCodeSyncError("LeetCode returned incomplete profile stats. Try again later.")

    submission_counts = {}
    submit_stats = matched_user.get("submitStats")
    if not isinstance(submit_stats, dict) or not isinstance(submit_stats.get("acSubmissionNum"), list):
        raise LeetCodeSyncError("LeetCode returned incomplete profile stats. Try again later.")
    for item in submit_stats["acSubmissionNum"]:
        try:
            submission_counts[item["difficulty"].lower()] = int(item["count"])
        except (KeyError, TypeError, ValueError, AttributeError):
            continue

    easy_solved = submission_counts.get("easy", 0)
    medium_solved = submission_counts.get("medium", 0)
    hard_solved = submission_counts.get("hard", 0)
    total_solved = submission_counts.get("all", easy_solved + medium_solved + hard_solved)
    question_totals = {}
    for item in payload.get("data", {}).get("allQuestionsCount") or []:
        try:
            question_totals[item["difficulty"].lower()] = int(item["count"])
        except (KeyError, TypeError, ValueError, AttributeError):
            continue
    languages_solved = []
    for item in matched_user.get("languageProblemCount") or []:
        try:
            languages_solved.append(
                {
                    "language_name": str(item["languageName"]),
                    "problems_solved": int(item["problemsSolved"]),
                }
            )
        except (KeyError, TypeError, ValueError, AttributeError):
            continue
    ranking = (matched_user.get("profile") or {}).get("ranking")
    try:
        global_rank = int(ranking) if ranking is not None else None
    except (TypeError, ValueError):
        global_rank = None

    return {
        "username": matched_user.get("username") or username,
        "total_solved": total_solved,
        "easy_solved": easy_solved,
        "medium_solved": medium_solved,
        "hard_solved": hard_solved,
        "global_rank": global_rank,
        "extra": {
            "question_totals": question_totals,
            "languages_solved": languages_solved,
        },
    }


def _set_sync_in_progress(platform: str, is_syncing: bool) -> None:
    with coding_sync_state_lock:
        if is_syncing:
            coding_syncs_in_progress.add(platform)
        else:
            coding_syncs_in_progress.discard(platform)


def _record_sync_failure(app: Flask, platform: str, message: str) -> None:
    checked_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    with closing(get_connection(app.config["DATABASE"])) as connection:
        connection.execute(
            "UPDATE coding_profiles SET last_checked_at = ?, last_sync_error = ? "
            "WHERE platform = ?",
            (checked_at, message[:500], platform),
        )
        connection.commit()


def sync_leetcode_profile(app: Flask, username: str) -> dict:
    with coding_sync_locks["leetcode"]:
        _set_sync_in_progress("leetcode", True)
        try:
            stats = fetch_leetcode_stats(username)
            fetched_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
            with closing(get_connection(app.config["DATABASE"])) as connection:
                connection.execute("BEGIN IMMEDIATE")
                profile = connection.execute(
                    "SELECT username FROM coding_profiles WHERE platform = 'leetcode'"
                ).fetchone()
                if profile is None or profile["username"] != username:
                    connection.rollback()
                    raise LeetCodeSyncError(
                        "The saved LeetCode profile changed. Save the profile link and sync again.", 409
                    )
                previous = connection.execute(
                    "SELECT total_solved FROM coding_stats_snapshot "
                    "WHERE platform = 'leetcode' ORDER BY fetched_at DESC, id DESC LIMIT 1"
                ).fetchone()
                previous_total = previous["total_solved"] if previous else None
                changed = previous_total is None or previous_total != stats["total_solved"]
                if changed:
                    connection.execute(
                        "INSERT INTO coding_stats_snapshot("
                        "platform, total_solved, easy_solved, medium_solved, hard_solved, "
                        "global_rank, extra_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                        (
                            "leetcode",
                            stats["total_solved"],
                            stats["easy_solved"],
                            stats["medium_solved"],
                            stats["hard_solved"],
                            stats["global_rank"],
                            json.dumps(stats.get("extra", {}), ensure_ascii=False),
                            fetched_at,
                        ),
                    )
                notification = None
                if previous_total is not None and stats["total_solved"] > previous_total:
                    notification = f"🎉 New LeetCode problem solved! Total: {stats['total_solved']}"
                connection.execute(
                    "UPDATE coding_profiles SET last_synced_at = ?, last_checked_at = ?, "
                    "last_sync_error = NULL, pending_notification = COALESCE(?, pending_notification) "
                    "WHERE platform = 'leetcode'",
                    (fetched_at, fetched_at, notification),
                )
                connection.commit()
            return {**stats, "fetched_at": fetched_at, "snapshot_saved": changed}
        except LeetCodeSyncError as error:
            _record_sync_failure(app, "leetcode", str(error))
            raise
        except requests.RequestException as error:
            message = "LeetCode is temporarily unavailable. Try again shortly."
            _record_sync_failure(app, "leetcode", message)
            raise LeetCodeSyncError(message, 503) from error
        except Exception:
            _record_sync_failure(app, "leetcode", "LeetCode sync failed unexpectedly.")
            raise
        finally:
            _set_sync_in_progress("leetcode", False)


def sync_configured_leetcode_profiles(app: Flask) -> None:
    with closing(get_connection(app.config["DATABASE"])) as connection:
        profiles = connection.execute(
            "SELECT username FROM coding_profiles WHERE platform = 'leetcode'"
        ).fetchall()
    for profile in profiles:
        try:
            sync_leetcode_profile(app, profile["username"])
        except LeetCodeSyncError as error:
            app.logger.warning("Scheduled LeetCode sync failed: %s", error)


def start_coding_stats_scheduler(app: Flask) -> None:
    if app.testing:
        return
    with coding_scheduler_lock:
        if "coding_stats_scheduler" in app.extensions:
            return
        scheduler = BackgroundScheduler(daemon=True)
        scheduler.add_job(
            sync_configured_leetcode_profiles,
            trigger="interval",
            minutes=15,
            args=[app],
            id="leetcode_stats_sync",
            replace_existing=True,
            max_instances=1,
            coalesce=True,
        )
        scheduler.start()
        app.extensions["coding_stats_scheduler"] = scheduler


def calculate_session_durations(
    events: list[sqlite3.Row], end_time: datetime | None = None
) -> tuple[int, int, int]:
    study_milliseconds = 0.0
    pause_milliseconds = 0.0
    pause_count = 0
    active_since = None
    paused_since = None

    for event in events:
        event_type = event["event_type"]
        event_time = datetime.fromisoformat(event["event_time"].replace("Z", "+00:00"))

        if event_type == "LOGIN":
            active_since = event_time
        elif event_type == "PAUSE" and active_since is not None:
            study_milliseconds += max(0, (event_time - active_since).total_seconds() * 1000)
            active_since = None
            paused_since = event_time
            pause_count += 1
        elif event_type == "RESUME" and paused_since is not None:
            pause_milliseconds += max(0, (event_time - paused_since).total_seconds() * 1000)
            paused_since = None
            active_since = event_time
        elif event_type == "LOGOFF":
            if active_since is not None:
                study_milliseconds += max(
                    0, (event_time - active_since).total_seconds() * 1000
                )
                active_since = None
            elif paused_since is not None:
                pause_milliseconds += max(
                    0, (event_time - paused_since).total_seconds() * 1000
                )
                paused_since = None

    if end_time is not None:
        if active_since is not None:
            study_milliseconds += max(0, (end_time - active_since).total_seconds() * 1000)
        elif paused_since is not None:
            pause_milliseconds += max(0, (end_time - paused_since).total_seconds() * 1000)

    return (
        int(study_milliseconds // 1000),
        int(pause_milliseconds // 1000),
        pause_count,
    )


def load_session_records(
    connection: sqlite3.Connection,
    where_clause: str = "",
    parameters: tuple = (),
) -> list[dict]:
    query = (
        "SELECT sessions.id AS session_id, sessions.domain_id, sessions.technology_id, "
        "sessions.date, sessions.is_college_day, "
        "sessions.started_at, sessions.ended_at, sessions.status, domains.name AS domain_name, "
        "COALESCE(technologies.name, 'General') AS technology_name "
        "FROM sessions JOIN domains ON domains.id = sessions.domain_id "
        "LEFT JOIN technologies ON technologies.id = sessions.technology_id "
        f"{where_clause} ORDER BY sessions.date DESC, sessions.started_at DESC"
    )
    sessions = connection.execute(query, parameters).fetchall()
    if not sessions:
        return []

    session_ids = [session["session_id"] for session in sessions]
    placeholders = ",".join("?" for _ in session_ids)
    events = connection.execute(
        "SELECT session_id, event_type, event_time FROM session_events "
        f"WHERE session_id IN ({placeholders}) ORDER BY session_id, id",
        session_ids,
    ).fetchall()
    events_by_session: dict[int, list[sqlite3.Row]] = {session_id: [] for session_id in session_ids}
    for event in events:
        events_by_session[event["session_id"]].append(event)

    now = datetime.now(timezone.utc)
    records = []
    for session in sessions:
        event_rows = events_by_session[session["session_id"]]
        end_time = now if session["status"] != "completed" else None
        study_seconds, pause_seconds, pause_count = calculate_session_durations(
            event_rows, end_time=end_time
        )
        records.append(
            {
                "session_id": session["session_id"],
                "domain_id": session["domain_id"],
                "technology_id": session["technology_id"],
                "date": session["date"],
                "domain_name": session["domain_name"],
                "technology_name": session["technology_name"],
                "is_college_day": bool(session["is_college_day"]),
                "started_at": session["started_at"],
                "ended_at": session["ended_at"],
                "status": session["status"],
                "study_seconds": study_seconds,
                "pause_seconds": pause_seconds,
                "pause_count": pause_count,
            }
        )
    return records


TECHNOLOGY_STUDY_TOTALS_SQL = """
WITH event_timeline AS (
    SELECT
        session_id,
        event_type,
        event_time,
        LEAD(event_type) OVER (PARTITION BY session_id ORDER BY id) AS next_event_type,
        LEAD(event_time) OVER (PARTITION BY session_id ORDER BY id) AS next_event_time
    FROM session_events
),
session_study AS (
    SELECT
        sessions.id AS session_id,
        CAST(ROUND(SUM(
            CASE
                WHEN event_timeline.event_type IN ('LOGIN', 'RESUME')
                    AND event_timeline.next_event_type IN ('PAUSE', 'LOGOFF')
                    THEN MAX(0.0, (julianday(event_timeline.next_event_time)
                        - julianday(event_timeline.event_time)) * 86400.0)
                WHEN event_timeline.event_type IN ('LOGIN', 'RESUME')
                    AND event_timeline.next_event_type IS NULL
                    AND sessions.status = 'active'
                    THEN MAX(0.0, (julianday('now')
                        - julianday(event_timeline.event_time)) * 86400.0)
                ELSE 0.0
            END
        )) AS INTEGER) AS study_seconds
    FROM sessions
    LEFT JOIN event_timeline ON event_timeline.session_id = sessions.id
    GROUP BY sessions.id
)
SELECT
    domains.id AS domain_id,
    domains.name AS domain_name,
    technologies.id AS technology_id,
    technologies.name AS technology_name,
    technologies.category,
    technologies.sort_order,
    technology_targets.target_hours,
    COALESCE(SUM(session_study.study_seconds), 0) AS study_seconds
FROM domains
JOIN technologies ON technologies.domain_id = domains.id
LEFT JOIN sessions
    ON sessions.technology_id = technologies.id
    AND sessions.domain_id = technologies.domain_id
LEFT JOIN session_study ON session_study.session_id = sessions.id
LEFT JOIN technology_targets ON technology_targets.technology_id = technologies.id
GROUP BY technologies.id
ORDER BY domains.id, technologies.sort_order, technologies.id
"""


def load_technology_study_totals(connection: sqlite3.Connection) -> dict[int, dict]:
    rows = connection.execute(TECHNOLOGY_STUDY_TOTALS_SQL).fetchall()
    totals: dict[int, dict] = {}
    for row in rows:
        domain = totals.setdefault(
            row["domain_id"],
            {"domain_id": row["domain_id"], "domain_name": row["domain_name"], "technologies": []},
        )
        study_seconds = int(row["study_seconds"] or 0)
        target_hours = row["target_hours"]
        target_seconds = round(target_hours * 3600) if target_hours is not None else None
        domain["technologies"].append(
            {
                "technology_id": row["technology_id"],
                "technology_name": row["technology_name"],
                "category": row["category"],
                "sort_order": row["sort_order"],
                "study_seconds": study_seconds,
                "target_hours": target_hours,
                "target_seconds": target_seconds,
                "progress_percent": min(100, round(study_seconds * 100 / target_seconds, 1))
                if target_seconds
                else 0,
            }
        )

    for domain in totals.values():
        domain["chart_technologies"] = sorted(
            domain["technologies"],
            key=lambda technology: technology["study_seconds"],
            reverse=True,
        )
        domain["covered_count"] = sum(
            technology["study_seconds"] >= 3600 for technology in domain["technologies"]
        )
        domain["technology_count"] = len(domain["technologies"])
    return totals


def create_app(test_config: dict | None = None) -> Flask:
    app = Flask(__name__)
    app.config["DATABASE"] = str(Path(__file__).with_name("study_tracker.db"))
    if test_config:
        app.config.update(test_config)

    initialize_database(Path(app.config["DATABASE"]))

    @app.before_request
    def ensure_coding_stats_scheduler():
        start_coding_stats_scheduler(app)

    @app.get("/")
    def index():
        with closing(get_connection(app.config["DATABASE"])) as connection:
            domains = connection.execute(
                "SELECT id, name FROM domains ORDER BY id"
            ).fetchall()
        return render_template("index.html", domains=domains)

    @app.get("/api/goals/today")
    def today_goals():
        today = datetime.now().astimezone().date().isoformat()
        with closing(get_connection(app.config["DATABASE"])) as connection:
            domains = connection.execute(
                "SELECT domains.id, domains.name, daily_goals.target_seconds "
                "FROM domains LEFT JOIN daily_goals ON daily_goals.domain_id = domains.id "
                "ORDER BY domains.id"
            ).fetchall()
            sessions = load_session_records(
                connection,
                "WHERE sessions.date = ?",
                (today,),
            )

        totals = {domain["name"]: 0 for domain in domains}
        for session in sessions:
            totals[session["domain_name"]] += session["study_seconds"]

        return jsonify(
            goals=[
                {
                    "domain_id": domain["id"],
                    "domain_name": domain["name"],
                    "target_seconds": domain["target_seconds"],
                    "study_seconds": totals[domain["name"]],
                    "progress_percent": min(
                        100,
                        round(totals[domain["name"]] * 100 / domain["target_seconds"], 1),
                    ) if domain["target_seconds"] else 0,
                }
                for domain in domains
            ]
        )

    @app.route("/api/coding-profiles", methods=["GET", "POST"])
    def coding_profiles():
        platforms = ("leetcode",)
        if request.method == "GET":
            with closing(get_connection(app.config["DATABASE"])) as connection:
                rows = connection.execute(
                    "SELECT platform, username, profile_url, last_synced_at, last_checked_at, "
                    "last_sync_error, pending_notification FROM coding_profiles"
                ).fetchall()
            saved_profiles = {row["platform"]: dict(row) for row in rows}
            return jsonify(
                profiles={
                    platform: saved_profiles.get(
                        platform,
                        {
                            "platform": platform,
                            "username": None,
                            "profile_url": None,
                            "last_synced_at": None,
                            "last_checked_at": None,
                            "last_sync_error": None,
                            "pending_notification": None,
                        },
                    )
                    for platform in platforms
                }
            )

        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify(error="Send a JSON request body."), 400

        profile_updates = {}
        for platform in platforms:
            url_key = f"{platform}_url"
            if url_key in payload:
                profile_url = payload[url_key]
                if profile_url is None:
                    profile_url = ""
                if not isinstance(profile_url, str):
                    return jsonify(error=f"{platform.title()} profile URL must be text."), 400
                profile_url = profile_url.strip()
                if len(profile_url) > 500:
                    return jsonify(error=f"{platform.title()} profile URL is too long."), 400
                if profile_url:
                    try:
                        username = parse_leetcode_profile_url(profile_url)
                    except ValueError as error:
                        return jsonify(error=str(error)), 400
                    profile_updates[platform] = (username, profile_url)
                else:
                    profile_updates[platform] = (None, None)
                continue
            if platform not in payload:
                continue
            username = payload[platform]
            if username is None:
                username = ""
            if not isinstance(username, str):
                return jsonify(error=f"{platform} username must be text."), 400
            username = username.strip()
            if len(username) > 100:
                return jsonify(error=f"{platform} username must be at most 100 characters."), 400
            profile_updates[platform] = (username or None, None)
        if not profile_updates:
            return jsonify(error="Provide at least one profile URL."), 400

        with closing(get_connection(app.config["DATABASE"])) as connection:
            for platform, (username, profile_url) in profile_updates.items():
                if username:
                    connection.execute(
                        "INSERT INTO coding_profiles(platform, username, profile_url) "
                        "VALUES (?, ?, ?) ON CONFLICT(platform) DO UPDATE SET "
                        "username = excluded.username, profile_url = excluded.profile_url, "
                        "last_synced_at = CASE WHEN coding_profiles.username <> excluded.username "
                        "THEN NULL ELSE coding_profiles.last_synced_at END, "
                        "last_checked_at = CASE WHEN coding_profiles.username <> excluded.username "
                        "THEN NULL ELSE coding_profiles.last_checked_at END, "
                        "last_sync_error = NULL, pending_notification = NULL",
                        (platform, username, profile_url),
                    )
                else:
                    connection.execute(
                        "DELETE FROM coding_profiles WHERE platform = ?", (platform,)
                    )
            rows = connection.execute(
                "SELECT platform, username, profile_url, last_synced_at, last_checked_at, "
                "last_sync_error, pending_notification FROM coding_profiles"
            ).fetchall()
            connection.commit()
        saved_profiles = {row["platform"]: dict(row) for row in rows}

        return jsonify(
            profiles={
                platform: saved_profiles.get(
                    platform,
                    {
                        "platform": platform,
                        "username": None,
                        "profile_url": None,
                        "last_synced_at": None,
                        "last_checked_at": None,
                        "last_sync_error": None,
                        "pending_notification": None,
                    },
                )
                for platform in platforms
            }
        )

    @app.get("/api/coding-profiles/snapshot")
    def coding_profile_snapshots():
        with closing(get_connection(app.config["DATABASE"])) as connection:
            rows = connection.execute(
                "SELECT platforms.platform, profiles.username, profiles.last_synced_at, "
                "profiles.last_checked_at, profiles.last_sync_error, "
                "snapshots.total_solved, "
                "snapshots.easy_solved, snapshots.medium_solved, snapshots.hard_solved, "
                "snapshots.global_rank, snapshots.extra_json, snapshots.fetched_at "
                "FROM (SELECT 'leetcode' AS platform) AS platforms "
                "LEFT JOIN coding_profiles AS profiles ON profiles.platform = platforms.platform "
                "LEFT JOIN coding_stats_snapshot AS snapshots ON snapshots.id = ("
                "SELECT latest.id FROM coding_stats_snapshot AS latest "
                "WHERE latest.platform = platforms.platform "
                "ORDER BY latest.fetched_at DESC, latest.id DESC LIMIT 1)"
            ).fetchall()

        snapshots = {
            platform: {
                "platform": platform,
                "username": None,
                "last_synced_at": None,
                "last_checked_at": None,
                "last_sync_error": None,
                "is_syncing": False,
                "snapshot": None,
            }
            for platform in ("leetcode",)
        }
        for row in rows:
            snapshot = None
            if row["fetched_at"] is not None:
                snapshot = {
                    key: row[key]
                    for key in (
                        "total_solved", "easy_solved", "medium_solved", "hard_solved",
                        "global_rank", "fetched_at",
                    )
                }
                try:
                    snapshot["extra"] = json.loads(row["extra_json"] or "{}")
                except (TypeError, json.JSONDecodeError):
                    snapshot["extra"] = {}
            snapshots[row["platform"]] = {
                "platform": row["platform"],
                "username": row["username"],
                "last_synced_at": row["last_synced_at"] or row["fetched_at"],
                "last_checked_at": row["last_checked_at"] or row["last_synced_at"] or row["fetched_at"],
                "last_sync_error": row["last_sync_error"],
                "is_syncing": row["platform"] in coding_syncs_in_progress,
                "snapshot": snapshot,
            }
        return jsonify(snapshots=snapshots)

    @app.get("/api/coding-profiles/notifications")
    def coding_profile_notifications():
        with closing(get_connection(app.config["DATABASE"])) as connection:
            connection.execute("BEGIN IMMEDIATE")
            rows = connection.execute(
                "SELECT platform, pending_notification FROM coding_profiles "
                "WHERE platform = 'leetcode' AND pending_notification IS NOT NULL"
            ).fetchall()
            connection.execute(
                "UPDATE coding_profiles SET pending_notification = NULL "
                "WHERE platform = 'leetcode' AND pending_notification IS NOT NULL"
            )
            connection.commit()
        return jsonify(
            notifications=[
                {"platform": row["platform"], "message": row["pending_notification"]}
                for row in rows
            ]
        )

    @app.post("/api/sync/leetcode")
    def sync_leetcode():
        with closing(get_connection(app.config["DATABASE"])) as connection:
            profile = connection.execute(
                "SELECT username FROM coding_profiles WHERE platform = 'leetcode'"
            ).fetchone()
        if profile is None:
            return jsonify(error="Save your LeetCode username before syncing."), 400

        try:
            snapshot = sync_leetcode_profile(app, profile["username"])
        except LeetCodeSyncError as error:
            return jsonify(error=str(error)), error.status_code
        return jsonify(username=profile["username"], snapshot=snapshot)

    @app.post("/api/goals")
    def set_goal():
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify(error="Send a JSON request body."), 400

        domain_id = payload.get("domain_id")
        target_hours = payload.get("target_hours")
        if isinstance(domain_id, bool) or not isinstance(domain_id, int):
            return jsonify(error="Choose a valid study domain."), 400
        if isinstance(target_hours, bool) or not isinstance(target_hours, (int, float)):
            return jsonify(error="Goal hours must be a number greater than zero."), 400
        if not math.isfinite(target_hours) or not 0 < target_hours <= 24:
            return jsonify(error="Goal hours must be greater than zero and at most 24."), 400

        target_seconds = round(target_hours * 3600)
        with closing(get_connection(app.config["DATABASE"])) as connection:
            domain = connection.execute(
                "SELECT id FROM domains WHERE id = ?", (domain_id,)
            ).fetchone()
            if domain is None:
                return jsonify(error="Choose a valid study domain."), 400
            connection.execute(
                "INSERT INTO daily_goals(domain_id, target_seconds) VALUES (?, ?) "
                "ON CONFLICT(domain_id) DO UPDATE SET target_seconds = excluded.target_seconds",
                (domain_id, target_seconds),
            )
            connection.commit()

        return jsonify(domain_id=domain_id, target_seconds=target_seconds), 200

    @app.get("/api/export/sessions.csv")
    def export_sessions():
        with closing(get_connection(app.config["DATABASE"])) as connection:
            records = load_session_records(connection)

        output = StringIO(newline="")
        writer = csv.writer(output)
        writer.writerow(
            [
                "session_id",
                "date",
                "domain",
                "technology",
                "college_day",
                "started_at",
                "ended_at",
                "status",
                "study_seconds",
                "pause_seconds",
                "pause_count",
            ]
        )
        for record in records:
            writer.writerow(
                [
                    record["session_id"],
                    record["date"],
                    record["domain_name"],
                    record["technology_name"] or "General",
                    "Y" if record["is_college_day"] else "N",
                    record["started_at"],
                    record["ended_at"] or "",
                    record["status"],
                    record["study_seconds"],
                    record["pause_seconds"],
                    record["pause_count"],
                ]
            )
        response = make_response("\ufeff" + output.getvalue())
        response.headers["Content-Type"] = "text/csv; charset=utf-8"
        response.headers["Content-Disposition"] = "attachment; filename=study-sessions.csv"
        return response

    @app.get("/api/export/events.csv")
    def export_events():
        with closing(get_connection(app.config["DATABASE"])) as connection:
            events = connection.execute(
                "SELECT session_events.id AS event_id, session_events.session_id, "
                "sessions.date, domains.name AS domain, "
                "COALESCE(technologies.name, 'General') AS technology, "
                "session_events.event_type, "
                "session_events.event_time, session_events.created_at "
                "FROM session_events "
                "JOIN sessions ON sessions.id = session_events.session_id "
                "JOIN domains ON domains.id = sessions.domain_id "
                "LEFT JOIN technologies ON technologies.id = sessions.technology_id "
                "ORDER BY session_events.id"
            ).fetchall()

        output = StringIO(newline="")
        writer = csv.writer(output)
        writer.writerow(
            [
                "event_id",
                "session_id",
                "date",
                "domain",
                "technology",
                "event_type",
                "event_time",
                "created_at",
            ]
        )
        for event in events:
            writer.writerow(tuple(event))
        response = make_response("\ufeff" + output.getvalue())
        response.headers["Content-Type"] = "text/csv; charset=utf-8"
        response.headers["Content-Disposition"] = "attachment; filename=study-events.csv"
        return response

    @app.get("/api/backup")
    def download_backup():
        database_path = Path(app.config["DATABASE"])
        backup_handle = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
        backup_path = Path(backup_handle.name)
        backup_handle.close()

        try:
            with closing(sqlite3.connect(database_path)) as source:
                with closing(sqlite3.connect(backup_path)) as destination:
                    source.backup(destination)
            response = send_file(
                backup_path,
                mimetype="application/vnd.sqlite3",
                as_attachment=True,
                download_name="study-tracker-backup.db",
            )
            response.call_on_close(lambda: backup_path.unlink(missing_ok=True))
            return response
        except Exception:
            backup_path.unlink(missing_ok=True)
            raise

    @app.get("/report")
    def monthly_report():
        current_month = datetime.now().astimezone().date().strftime("%Y-%m")
        month = request.args.get("month", current_month)
        try:
            parsed_month = datetime.strptime(month, "%Y-%m").date()
            if parsed_month.strftime("%Y-%m") != month:
                raise ValueError
        except ValueError:
            month = current_month
        return render_template("report.html", month=month)

    @app.get("/api/report/monthly")
    def monthly_report_data():
        month = request.args.get("month", datetime.now().astimezone().date().strftime("%Y-%m"))
        try:
            month_start = datetime.strptime(month, "%Y-%m").date().replace(day=1)
            if month_start.strftime("%Y-%m") != month:
                raise ValueError
        except ValueError:
            return jsonify(error="Month must use YYYY-MM format."), 400

        next_month = (
            month_start.replace(year=month_start.year + 1, month=1)
            if month_start.month == 12
            else month_start.replace(month=month_start.month + 1)
        )
        with closing(get_connection(app.config["DATABASE"])) as connection:
            records = load_session_records(
                connection,
                "WHERE sessions.date >= ? AND sessions.date < ?",
                (month_start.isoformat(), next_month.isoformat()),
            )
            domains = connection.execute("SELECT name FROM domains ORDER BY id").fetchall()
            technologies = connection.execute(
                "SELECT technologies.id, technologies.domain_id, technologies.name, "
                "technologies.category, technologies.sort_order, technology_targets.target_hours, "
                "domains.name AS domain_name "
                "FROM technologies JOIN domains ON domains.id = technologies.domain_id "
                "LEFT JOIN technology_targets ON technology_targets.technology_id = technologies.id "
                "ORDER BY domains.id, technologies.sort_order, technologies.id"
            ).fetchall()

        domain_totals = {domain["name"]: 0 for domain in domains}
        technology_totals = {technology["id"]: 0 for technology in technologies}
        day_totals: dict[tuple[str, bool], int] = {}
        for record in records:
            domain_totals[record["domain_name"]] += record["study_seconds"]
            if record["technology_id"] in technology_totals:
                technology_totals[record["technology_id"]] += record["study_seconds"]
            key = (record["date"], record["is_college_day"])
            day_totals[key] = day_totals.get(key, 0) + record["study_seconds"]

        technology_details = []
        for domain in domains:
            domain_technologies = []
            for technology in technologies:
                if technology["domain_name"] != domain["name"]:
                    continue
                studied_seconds = technology_totals[technology["id"]]
                domain_total = domain_totals[domain["name"]]
                target_hours = technology["target_hours"]
                target_seconds = round(target_hours * 3600) if target_hours is not None else None
                if studied_seconds == 0:
                    status = "Not started"
                elif target_seconds is None or studied_seconds >= target_seconds:
                    status = "On track"
                else:
                    status = "Behind"
                domain_technologies.append(
                    {
                        "technology_id": technology["id"],
                        "technology_name": technology["name"],
                        "category": technology["category"],
                        "sort_order": technology["sort_order"],
                        "study_seconds": studied_seconds,
                        "domain_percent": round(studied_seconds * 100 / domain_total, 1)
                        if domain_total
                        else 0,
                        "target_hours": target_hours,
                        "status": status,
                    }
                )

            studied_topics = [topic for topic in domain_technologies if topic["study_seconds"] > 0]
            most_studied = max(studied_topics, key=lambda topic: topic["study_seconds"]) if studied_topics else None
            least_studied = min(domain_technologies, key=lambda topic: topic["study_seconds"]) if studied_topics else None
            technology_details.append(
                {
                    "domain_name": domain["name"],
                    "domain_total_seconds": domain_totals[domain["name"]],
                    "technologies": domain_technologies,
                    "most_studied": most_studied,
                    "least_studied": least_studied,
                }
            )

        college_days = [seconds for (_, is_college_day), seconds in day_totals.items() if is_college_day]
        non_college_days = [seconds for (_, is_college_day), seconds in day_totals.items() if not is_college_day]
        return jsonify(
            month=month,
            domain_totals=domain_totals,
            technology_details=technology_details,
            college_day_average_seconds=(sum(college_days) / len(college_days)) if college_days else 0,
            college_day_count=len(college_days),
            non_college_day_average_seconds=(sum(non_college_days) / len(non_college_days)) if non_college_days else 0,
            non_college_day_count=len(non_college_days),
        )

    @app.get("/api/current-session")
    def current_session():
        with closing(get_connection(app.config["DATABASE"])) as connection:
            session = connection.execute(
                "SELECT sessions.id, sessions.domain_id, sessions.technology_id, "
                "domains.name AS domain_name, technologies.name AS technology_name, "
                "sessions.started_at, sessions.status, sessions.is_college_day "
                "FROM sessions JOIN domains ON domains.id = sessions.domain_id "
                "LEFT JOIN technologies ON technologies.id = sessions.technology_id "
                "WHERE sessions.status IN ('active', 'paused') LIMIT 1"
            ).fetchone()
            if session is None:
                return jsonify(session=None)

            events = connection.execute(
                "SELECT event_type, event_time FROM session_events "
                "WHERE session_id = ? ORDER BY id",
                (session["id"],),
            ).fetchall()

        return jsonify(
            session={
                "session_id": session["id"],
                "domain_id": session["domain_id"],
                "technology_id": session["technology_id"],
                "domain_name": session["domain_name"],
                "technology_name": session["technology_name"] or "General",
                "started_at": session["started_at"],
                "status": session["status"],
                "is_college_day": bool(session["is_college_day"]),
                "events": [dict(event) for event in events],
            }
        )

    @app.get("/api/technologies")
    def technologies():
        domain_id = request.args.get("domain_id", type=int)
        if domain_id is None or domain_id < 1:
            return jsonify(error="A valid domain_id query parameter is required."), 400

        with closing(get_connection(app.config["DATABASE"])) as connection:
            domain = connection.execute(
                "SELECT id FROM domains WHERE id = ?", (domain_id,)
            ).fetchone()
            if domain is None:
                return jsonify(error="Domain not found."), 404
            rows = connection.execute(
                "SELECT id, domain_id, name, category, sort_order FROM technologies "
                "WHERE domain_id = ? ORDER BY sort_order, id",
                (domain_id,),
            ).fetchall()

        return jsonify(technologies=[dict(row) for row in rows])

    @app.get("/api/technology-progress")
    def technology_progress():
        domain_id = request.args.get("domain_id", type=int)
        if domain_id is None or domain_id < 1:
            return jsonify(error="A valid domain_id query parameter is required."), 400

        with closing(get_connection(app.config["DATABASE"])) as connection:
            domain = connection.execute(
                "SELECT id, name FROM domains WHERE id = ?", (domain_id,)
            ).fetchone()
            if domain is None:
                return jsonify(error="Domain not found."), 404
            technology_totals = load_technology_study_totals(connection).get(
                domain_id,
                {"technologies": [], "covered_count": 0, "technology_count": 0},
            )

        return jsonify(
            domain_id=domain_id,
            domain_name=domain["name"],
            technologies=technology_totals["technologies"],
            covered_count=technology_totals["covered_count"],
            technology_count=technology_totals["technology_count"],
        )

    @app.post("/api/technology-targets")
    def set_technology_target():
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify(error="Send a JSON request body."), 400

        technology_id = payload.get("technology_id")
        target_hours = payload.get("target_hours")
        if isinstance(technology_id, bool) or not isinstance(technology_id, int):
            return jsonify(error="Choose a valid technology."), 400
        if isinstance(target_hours, bool) or not isinstance(target_hours, (int, float)):
            return jsonify(error="Target hours must be a number greater than zero."), 400
        if not math.isfinite(target_hours) or not 0 < target_hours <= 24:
            return jsonify(error="Target hours must be greater than zero and at most 24."), 400

        with closing(get_connection(app.config["DATABASE"])) as connection:
            technology = connection.execute(
                "SELECT id FROM technologies WHERE id = ?", (technology_id,)
            ).fetchone()
            if technology is None:
                return jsonify(error="Technology not found."), 404
            connection.execute(
                "INSERT INTO technology_targets(technology_id, target_hours) VALUES (?, ?) "
                "ON CONFLICT(technology_id) DO UPDATE SET target_hours = excluded.target_hours",
                (technology_id, float(target_hours)),
            )
            connection.commit()

        return jsonify(technology_id=technology_id, target_hours=float(target_hours)), 200

    @app.get("/dashboard")
    def dashboard():
        with closing(get_connection(app.config["DATABASE"])) as connection:
            domains = connection.execute("SELECT id, name FROM domains ORDER BY id").fetchall()
        return render_template("dashboard.html", domains=domains)

    @app.get("/history")
    def history():
        with closing(get_connection(app.config["DATABASE"])) as connection:
            domains = connection.execute("SELECT id, name FROM domains ORDER BY id").fetchall()
        return render_template("history.html", domains=domains)

    @app.get("/api/sessions")
    def sessions():
        where = []
        parameters = []
        start_date = request.args.get("start_date")
        end_date = request.args.get("end_date")
        domain_id = request.args.get("domain_id")
        technology_id = request.args.get("technology_id")
        college_only = request.args.get("college_day")

        try:
            if start_date:
                parsed_start = date.fromisoformat(start_date)
                if parsed_start.isoformat() != start_date:
                    raise ValueError
                where.append("sessions.date >= ?")
                parameters.append(start_date)
            if end_date:
                parsed_end = date.fromisoformat(end_date)
                if parsed_end.isoformat() != end_date:
                    raise ValueError
                where.append("sessions.date <= ?")
                parameters.append(end_date)
            if start_date and end_date and parsed_start > parsed_end:
                return jsonify(error="Start date must be on or before end date."), 400
        except ValueError:
            return jsonify(error="Dates must use YYYY-MM-DD format."), 400

        if domain_id:
            try:
                parsed_domain_id = int(domain_id)
            except ValueError:
                return jsonify(error="Domain filter must be a valid domain ID."), 400
            if parsed_domain_id < 1:
                return jsonify(error="Domain filter must be a valid domain ID."), 400
            where.append("sessions.domain_id = ?")
            parameters.append(parsed_domain_id)

        if technology_id:
            try:
                parsed_technology_id = int(technology_id)
            except ValueError:
                return jsonify(error="Technology filter must be a valid technology ID."), 400
            if parsed_technology_id < 1:
                return jsonify(error="Technology filter must be a valid technology ID."), 400
            with closing(get_connection(app.config["DATABASE"])) as connection:
                technology = connection.execute(
                    "SELECT domain_id FROM technologies WHERE id = ?",
                    (parsed_technology_id,),
                ).fetchone()
            if technology is None:
                return jsonify(error="Technology not found."), 404
            if domain_id and technology["domain_id"] != parsed_domain_id:
                return jsonify(error="Technology does not belong to the selected domain."), 400
            where.append("sessions.technology_id = ?")
            parameters.append(parsed_technology_id)

        if college_only:
            if college_only not in ("1", "true"):
                return jsonify(error="college_day must be 1 when enabled."), 400
            where.append("sessions.is_college_day = 1")

        where_clause = f"WHERE {' AND '.join(where)}" if where else ""
        with closing(get_connection(app.config["DATABASE"])) as connection:
            records = load_session_records(connection, where_clause, tuple(parameters))
        return jsonify(sessions=records)

    @app.get("/api/sessions/<int:session_id>/events")
    def session_events(session_id: int):
        with closing(get_connection(app.config["DATABASE"])) as connection:
            session = connection.execute(
                "SELECT id FROM sessions WHERE id = ?", (session_id,)
            ).fetchone()
            if session is None:
                return jsonify(error="Session not found."), 404
            events = connection.execute(
                "SELECT id, event_type, event_time, created_at FROM session_events "
                "WHERE session_id = ? ORDER BY id",
                (session_id,),
            ).fetchall()
        return jsonify(session_id=session_id, events=[dict(event) for event in events])

    @app.get("/api/dashboard")
    def dashboard_data():
        today = datetime.now().astimezone().date()
        week_start = today - timedelta(days=today.weekday())
        month_start = today.replace(day=1)
        chart_start = today - timedelta(days=29)

        with closing(get_connection(app.config["DATABASE"])) as connection:
            records = load_session_records(connection)
            domains = connection.execute("SELECT name FROM domains ORDER BY id").fetchall()
            technology_breakdown = load_technology_study_totals(connection)

        today_seconds = 0
        week_seconds = 0
        month_seconds = 0
        domain_totals = {domain["name"]: 0 for domain in domains}
        daily_totals = {}
        studied_dates = set()

        for record in records:
            session_date = date.fromisoformat(record["date"])
            seconds = record["study_seconds"]
            if session_date == today:
                today_seconds += seconds
            if week_start <= session_date <= today:
                week_seconds += seconds
            if month_start <= session_date <= today:
                month_seconds += seconds
            if record["domain_name"] in domain_totals:
                domain_totals[record["domain_name"]] += seconds
            if chart_start <= session_date <= today:
                daily_totals[session_date.isoformat()] = (
                    daily_totals.get(session_date.isoformat(), 0) + seconds
                )
            if seconds > 0:
                studied_dates.add(session_date)

        streak = 0
        streak_day = today if today in studied_dates else today - timedelta(days=1)
        while streak_day in studied_dates:
            streak += 1
            streak_day -= timedelta(days=1)

        chart_days = [chart_start + timedelta(days=offset) for offset in range(30)]
        return jsonify(
            today_study_seconds=today_seconds,
            week_study_seconds=week_seconds,
            month_study_seconds=month_seconds,
            streak_days=streak,
            domain_split={name: seconds for name, seconds in domain_totals.items()},
            technology_breakdown=list(technology_breakdown.values()),
            daily_study_hours={
                "labels": [day.isoformat() for day in chart_days],
                "values": [daily_totals.get(day.isoformat(), 0) / 3600 for day in chart_days],
            },
        )

    @app.post("/api/login")
    def login():
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify(error="Send a JSON request body."), 400

        domain_id = payload.get("domain_id")
        technology_id = payload.get("technology_id")
        is_college_day = payload.get("is_college_day")
        if isinstance(domain_id, bool) or not isinstance(domain_id, int):
            return jsonify(error="Choose a valid study domain."), 400
        if not isinstance(is_college_day, bool):
            return jsonify(error="Choose whether today is a college day."), 400
        if (
            isinstance(technology_id, bool)
            or not isinstance(technology_id, int)
        ):
            return jsonify(error="Choose a technology before starting the session."), 400

        started_at = datetime.now(timezone.utc)
        event_time = started_at.isoformat(timespec="microseconds").replace("+00:00", "Z")
        session_date = started_at.astimezone().date().isoformat()

        with closing(get_connection(app.config["DATABASE"])) as connection:
            try:
                connection.execute("BEGIN IMMEDIATE")

                domain = connection.execute(
                    "SELECT id, name FROM domains WHERE id = ?", (domain_id,)
                ).fetchone()
                if domain is None:
                    connection.rollback()
                    return jsonify(error="Choose a valid study domain."), 400

                technology = connection.execute(
                    "SELECT id FROM technologies WHERE id = ? AND domain_id = ?",
                    (technology_id, domain_id),
                ).fetchone()
                if technology is None:
                    connection.rollback()
                    return jsonify(error="Technology does not belong to the selected domain."), 400

                open_session = connection.execute(
                    "SELECT id FROM sessions "
                    "WHERE status IN ('active', 'paused') LIMIT 1"
                ).fetchone()
                if open_session is not None:
                    connection.rollback()
                    return jsonify(error="You already have an active session."), 409

                cursor = connection.execute(
                    "INSERT INTO sessions "
                    "(domain_id, technology_id, date, is_college_day, started_at, status) "
                    "VALUES (?, ?, ?, ?, ?, 'active')",
                    (domain_id, technology_id, session_date, int(is_college_day), event_time),
                )
                session_id = cursor.lastrowid
                connection.execute(
                    "INSERT INTO session_events (session_id, event_type, event_time) "
                    "VALUES (?, 'LOGIN', ?)",
                    (session_id, event_time),
                )
                connection.commit()
            except sqlite3.IntegrityError:
                connection.rollback()
                return jsonify(error="You already have an active session."), 409

        return jsonify(
            session_id=session_id,
            domain_id=domain["id"],
            technology_id=technology_id,
            domain_name=domain["name"],
            is_college_day=is_college_day,
            started_at=event_time,
        ), 201

    def transition_session(expected_status: str, next_status: str, event_type: str):
        event_time = datetime.now(timezone.utc).isoformat(timespec="microseconds").replace(
            "+00:00", "Z"
        )

        with closing(get_connection(app.config["DATABASE"])) as connection:
            connection.execute("BEGIN IMMEDIATE")
            session = connection.execute(
                "SELECT id, status FROM sessions "
                "WHERE status IN ('active', 'paused') LIMIT 1"
            ).fetchone()

            if session is None:
                connection.rollback()
                return jsonify(error="No active session found."), 409
            if session["status"] != expected_status:
                connection.rollback()
                if event_type == "PAUSE":
                    return jsonify(error="Session is already paused."), 409
                return jsonify(error="Session is not paused."), 409

            connection.execute(
                "UPDATE sessions SET status = ? WHERE id = ? AND status = ?",
                (next_status, session["id"], expected_status),
            )
            connection.execute(
                "INSERT INTO session_events (session_id, event_type, event_time) "
                "VALUES (?, ?, ?)",
                (session["id"], event_type, event_time),
            )
            connection.commit()

        return jsonify(session_id=session["id"], status=next_status, event_time=event_time)

    @app.post("/api/pause")
    def pause():
        return transition_session("active", "paused", "PAUSE")

    @app.post("/api/resume")
    def resume():
        return transition_session("paused", "active", "RESUME")

    @app.post("/api/logoff")
    def logoff():
        event_time = datetime.now(timezone.utc).isoformat(timespec="microseconds").replace(
            "+00:00", "Z"
        )

        with closing(get_connection(app.config["DATABASE"])) as connection:
            connection.execute("BEGIN IMMEDIATE")
            session = connection.execute(
                "SELECT sessions.id, sessions.status, sessions.started_at, domains.name "
                "FROM sessions JOIN domains ON domains.id = sessions.domain_id "
                "WHERE sessions.status IN ('active', 'paused') LIMIT 1"
            ).fetchone()

            if session is None:
                connection.rollback()
                return jsonify(error="No active session found."), 409

            if session["status"] == "paused":
                connection.execute(
                    "INSERT INTO session_events (session_id, event_type, event_time) "
                    "VALUES (?, 'RESUME', ?)",
                    (session["id"], event_time),
                )

            connection.execute(
                "INSERT INTO session_events (session_id, event_type, event_time) "
                "VALUES (?, 'LOGOFF', ?)",
                (session["id"], event_time),
            )
            events = connection.execute(
                "SELECT event_type, event_time FROM session_events "
                "WHERE session_id = ? ORDER BY id",
                (session["id"],),
            ).fetchall()
            study_seconds, pause_seconds, pause_count = calculate_session_durations(events)
            connection.execute(
                "UPDATE sessions SET ended_at = ?, status = 'completed', "
                "total_study_seconds = ?, total_pause_seconds = ? WHERE id = ?",
                (event_time, study_seconds, pause_seconds, session["id"]),
            )
            connection.commit()

        return jsonify(
            session_id=session["id"],
            domain_name=session["name"],
            started_at=session["started_at"],
            ended_at=event_time,
            study_seconds=study_seconds,
            pause_seconds=pause_seconds,
            pause_count=pause_count,
        )

    return app


app = create_app()


if __name__ == "__main__":
    app.run(debug=True)