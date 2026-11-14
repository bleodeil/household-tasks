#!/usr/bin/env python3
"""Database layer — SQLite + recurrence logic"""

import calendar
import json
import logging
import sqlite3
from datetime import date, datetime, timedelta

from dateutil.relativedelta import relativedelta

logger = logging.getLogger(__name__)


# ── Helpers ────────────────────────────────────────────────────────────────────

def _row_factory(cursor, row):
    """Return rows as plain dicts."""
    return {col[0]: row[i] for i, col in enumerate(cursor.description)}


def _parse_date(d):
    if isinstance(d, date):
        return d
    return datetime.fromisoformat(d).date()


# ── Database class ─────────────────────────────────────────────────────────────

class Database:
    def __init__(self, path):
        self.path = path

    def _conn(self):
        conn = sqlite3.connect(self.path)
        conn.row_factory = _row_factory
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    # ── Schema ─────────────────────────────────────────────────────────────────

    def initialize(self):
        """Create tables if they do not exist."""
        conn = self._conn()
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS rooms (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT NOT NULL UNIQUE,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT    NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS members (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT NOT NULL UNIQUE,
                color      TEXT NOT NULL DEFAULT '#3b82f6',
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS tasks (
                id                 INTEGER PRIMARY KEY AUTOINCREMENT,
                room_id            INTEGER NOT NULL
                                   REFERENCES rooms(id) ON DELETE CASCADE,
                title              TEXT    NOT NULL,
                description        TEXT,
                assigned_member_id INTEGER
                                   REFERENCES members(id) ON DELETE SET NULL,
                is_recurring       INTEGER NOT NULL DEFAULT 0,
                recurrence_type    TEXT,
                recurrence_config  TEXT,          -- JSON blob
                due_date           TEXT,          -- YYYY-MM-DD
                created_at         TEXT    NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS completion_log (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id      INTEGER NOT NULL
                             REFERENCES tasks(id) ON DELETE CASCADE,
                member_id    INTEGER
                             REFERENCES members(id) ON DELETE SET NULL,
                completed_at TEXT NOT NULL,       -- ISO-8601 datetime
                notes        TEXT
            );
        """)
        conn.commit()
        conn.close()
        logger.info("Database ready at %s", self.path)

    # ── Rooms ──────────────────────────────────────────────────────────────────

    def get_rooms(self):
        conn = self._conn()
        c = conn.cursor()
        rooms = c.execute(
            "SELECT * FROM rooms ORDER BY sort_order, name COLLATE NOCASE"
        ).fetchall()

        today = date.today()

        for room in rooms:
            tasks = c.execute(
                "SELECT due_date FROM tasks WHERE room_id = ?", (room["id"],)
            ).fetchall()
            room["task_count"]      = len(tasks)
            room["overdue_count"]   = sum(
                1 for t in tasks
                if t["due_date"] and _parse_date(t["due_date"]) < today
            )
            room["due_today_count"] = sum(
                1 for t in tasks
                if t["due_date"] and _parse_date(t["due_date"]) == today
            )
        conn.close()
        return rooms

    def create_room(self, name):
        conn = self._conn()
        c = conn.cursor()
        c.execute("INSERT INTO rooms (name) VALUES (?)", (name,))
        rid = c.lastrowid
        conn.commit()
        room = c.execute("SELECT * FROM rooms WHERE id = ?", (rid,)).fetchone()
        conn.close()
        return room

    def update_room(self, room_id, name):
        conn = self._conn()
        c = conn.cursor()
        c.execute("UPDATE rooms SET name = ? WHERE id = ?", (name, room_id))
        conn.commit()
        room = c.execute("SELECT * FROM rooms WHERE id = ?", (room_id,)).fetchone()
        conn.close()
        return room

    def delete_room(self, room_id):
        conn = self._conn()
        conn.execute("DELETE FROM rooms WHERE id = ?", (room_id,))
        conn.commit()
        conn.close()

    # ── Members ────────────────────────────────────────────────────────────────

    def get_members(self):
        conn = self._conn()
        members = conn.execute(
            "SELECT * FROM members ORDER BY name COLLATE NOCASE"
        ).fetchall()
        conn.close()
        return members

    def create_member(self, name, color):
        conn = self._conn()
        c = conn.cursor()
        c.execute("INSERT INTO members (name, color) VALUES (?, ?)", (name, color))
        mid = c.lastrowid
        conn.commit()
        member = c.execute("SELECT * FROM members WHERE id = ?", (mid,)).fetchone()
        conn.close()
        return member

    def update_member(self, member_id, name, color):
        conn = self._conn()
        c = conn.cursor()
        c.execute(
            "UPDATE members SET name = ?, color = ? WHERE id = ?",
            (name, color, member_id),
        )
        conn.commit()
        member = c.execute("SELECT * FROM members WHERE id = ?", (member_id,)).fetchone()
        conn.close()
        return member

    def delete_member(self, member_id):
        conn = self._conn()
        conn.execute("DELETE FROM members WHERE id = ?", (member_id,))
        conn.commit()
        conn.close()

    # ── Tasks ──────────────────────────────────────────────────────────────────

    def get_tasks(self, room_id=None):
        conn = self._conn()
        if room_id:
            tasks = conn.execute("""
                SELECT t.*,
                       m.name  AS member_name,
                       m.color AS member_color
                FROM tasks t
                LEFT JOIN members m ON t.assigned_member_id = m.id
                WHERE t.room_id = ?
                ORDER BY
                    CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END,
                    t.due_date ASC,
                    t.title COLLATE NOCASE
            """, (room_id,)).fetchall()
        else:
            tasks = conn.execute("""
                SELECT t.*,
                       m.name  AS member_name,
                       m.color AS member_color,
                       r.name  AS room_name
                FROM tasks t
                LEFT JOIN members m ON t.assigned_member_id = m.id
                LEFT JOIN rooms   r ON t.room_id = r.id
                ORDER BY
                    CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END,
                    t.due_date ASC,
                    t.title COLLATE NOCASE
            """).fetchall()
        conn.close()
        return tasks

    def get_task(self, task_id):
        conn = self._conn()
        task = conn.execute("""
            SELECT t.*,
                   m.name  AS member_name,
                   m.color AS member_color,
                   r.name  AS room_name
            FROM tasks t
            LEFT JOIN members m ON t.assigned_member_id = m.id
            LEFT JOIN rooms   r ON t.room_id = r.id
            WHERE t.id = ?
        """, (task_id,)).fetchone()
        conn.close()
        return task

    def create_task(self, data):
        conn = self._conn()
        c = conn.cursor()
        c.execute("""
            INSERT INTO tasks
                (room_id, title, description, assigned_member_id,
                 is_recurring, recurrence_type, recurrence_config, due_date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            data["room_id"],
            data["title"].strip(),
            (data.get("description") or "").strip() or None,
            data.get("assigned_member_id") or None,
            1 if data.get("is_recurring") else 0,
            data.get("recurrence_type") or None,
            json.dumps(data["recurrence_config"]) if data.get("recurrence_config") else None,
            data.get("due_date") or None,
        ))
        tid = c.lastrowid
        conn.commit()
        conn.close()
        return self.get_task(tid)

    def update_task(self, task_id, data):
        conn = self._conn()
        conn.execute("""
            UPDATE tasks SET
                room_id            = ?,
                title              = ?,
                description        = ?,
                assigned_member_id = ?,
                is_recurring       = ?,
                recurrence_type    = ?,
                recurrence_config  = ?,
                due_date           = ?
            WHERE id = ?
        """, (
            data["room_id"],
            data["title"].strip(),
            (data.get("description") or "").strip() or None,
            data.get("assigned_member_id") or None,
            1 if data.get("is_recurring") else 0,
            data.get("recurrence_type") or None,
            json.dumps(data["recurrence_config"]) if data.get("recurrence_config") else None,
            data.get("due_date") or None,
            task_id,
        ))
        conn.commit()
        conn.close()
        return self.get_task(task_id)

    def delete_task(self, task_id):
        conn = self._conn()
        conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
        conn.commit()
        conn.close()

    def complete_task(self, task_id, data):
        conn = self._conn()
        c = conn.cursor()

        task = c.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        if task is None:
            conn.close()
            return None

        completed_at = data.get("completed_at") or datetime.now().isoformat(timespec="seconds")
        member_id    = data.get("member_id") or None

        # Write to completion log
        c.execute("""
            INSERT INTO completion_log (task_id, member_id, completed_at, notes)
            VALUES (?, ?, ?, ?)
        """, (task_id, member_id, completed_at, data.get("notes") or None))

        if task["is_recurring"] and task["recurrence_type"]:
            # Recurring: recalculate next due date
            cfg  = json.loads(task["recurrence_config"]) if task["recurrence_config"] else {}
            from_date = datetime.fromisoformat(completed_at).date()
            next_due  = _calculate_next_due(task["recurrence_type"], cfg, from_date)
            c.execute(
                "UPDATE tasks SET due_date = ? WHERE id = ?",
                (next_due.isoformat() if next_due else None, task_id),
            )
            conn.commit()
            conn.close()
            return self.get_task(task_id)
        else:
            # Non-recurring: delete the task after logging completion
            conn.commit()
            conn.close()
            self.delete_task(task_id)
            return {"deleted": True, "id": task_id}

    def get_task_log(self, task_id):
        conn = self._conn()
        log = conn.execute("""
            SELECT l.*,
                   m.name  AS member_name,
                   m.color AS member_color
            FROM completion_log l
            LEFT JOIN members m ON l.member_id = m.id
            WHERE l.task_id = ?
            ORDER BY l.completed_at DESC
        """, (task_id,)).fetchall()
        conn.close()
        return log

    def get_streak(self):
        """Return streak info dict.

        {"streak": N, "has_history": bool}

        streak = 0  → a task is currently overdue
        streak = N  → days since last late completion
        has_history = False → no late completions ever recorded (new install);
                               the frontend shows a neutral "getting started" banner.
        """
        from datetime import date, datetime, timezone
        today = date.today().isoformat()
        conn = self._conn()

        # If any task is currently overdue → streak broken
        overdue = conn.execute(
            "SELECT 1 FROM tasks WHERE due_date IS NOT NULL AND due_date < ? LIMIT 1",
            (today,)
        ).fetchone()
        if overdue:
            conn.close()
            return {"streak": 0, "has_history": True}

        # Find the most recent late completion (completed after its due_date)
        row = conn.execute("""
            SELECT l.completed_at
            FROM completion_log l
            JOIN tasks t ON t.id = l.task_id
            WHERE t.due_date IS NOT NULL
              AND substr(l.completed_at, 1, 10) > t.due_date
            ORDER BY l.completed_at DESC
            LIMIT 1
        """).fetchone()
        conn.close()

        if not row:
            # No late completions ever — fresh install or perfectly on-time history
            return {"streak": 0, "has_history": False}

        late_ts = row["completed_at"]
        late_dt = datetime.fromisoformat(late_ts.replace("Z", "+00:00"))
        now_dt  = datetime.now(timezone.utc)
        days    = int((now_dt - late_dt).total_seconds() // 86400)
        return {"streak": max(days, 0), "has_history": True}


# ── Recurrence calculation ─────────────────────────────────────────────────────

def _calculate_next_due(recurrence_type, config, from_date):
    """
    Return the next due date after a task is completed.

    recurrence_type values and their config keys:
        x_days           value  — every N days from completion
        x_weeks          value  — every N weeks from completion
        x_months         value  — every N months from completion
        x_years          value  — every N years from completion
        weekly_days      days   — list of weekday ints (0=Mon … 6=Sun)
        monthly_dom      day    — day of month (1–31)
        monthly_nth_dow  n, weekday — Nth (1–5) occurrence of weekday (0–6)
    """
    v = config.get("value", 1)

    if recurrence_type == "x_days":
        return from_date + timedelta(days=v)

    if recurrence_type == "x_weeks":
        return from_date + timedelta(weeks=v)

    if recurrence_type == "x_months":
        return from_date + relativedelta(months=v)

    if recurrence_type == "x_years":
        return from_date + relativedelta(years=v)

    if recurrence_type == "weekly_days":
        days = config.get("days", [])
        if not days:
            return from_date + timedelta(weeks=1)
        check = from_date + timedelta(days=1)
        for _ in range(14):
            if check.weekday() in days:
                return check
            check += timedelta(days=1)
        return from_date + timedelta(weeks=1)

    if recurrence_type == "monthly_dom":
        dom = config.get("day", 1)
        nxt = from_date + relativedelta(months=1)
        max_day = calendar.monthrange(nxt.year, nxt.month)[1]
        return date(nxt.year, nxt.month, min(dom, max_day))

    if recurrence_type == "monthly_nth_dow":
        n       = config.get("n", 1)
        weekday = config.get("weekday", 0)
        nxt = from_date + relativedelta(months=1)
        return _nth_weekday_of_month(nxt.year, nxt.month, n, weekday)

    return None


def _nth_weekday_of_month(year, month, n, weekday):
    """Return the nth occurrence (1-indexed) of a weekday in a given month."""
    first      = date(year, month, 1)
    days_ahead = (weekday - first.weekday()) % 7
    first_occ  = first + timedelta(days=days_ahead)
    result     = first_occ + timedelta(weeks=n - 1)
    if result.month != month:
        # 5th occurrence doesn't exist — fall back to 4th
        result -= timedelta(weeks=1)
    return result
