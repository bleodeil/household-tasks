#!/usr/bin/env python3
"""Household Tasks — Flask backend"""

import os
import logging
import threading
import time
import requests as _requests
from flask import Flask, jsonify, request, render_template
from database import Database

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

app = Flask(__name__, template_folder="templates", static_folder="static")

DB_PATH = "/data/household_tasks.db"
db = Database(DB_PATH)


# ── Main page ──────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    # HA Ingress passes the base path in this header so the frontend
    # can prefix all API calls and asset URLs correctly.
    ingress_path = request.headers.get("X-Ingress-Path", "").rstrip("/")
    return render_template("index.html", ingress_path=ingress_path)


# ── Rooms ──────────────────────────────────────────────────────────────────────

@app.route("/api/rooms", methods=["GET"])
def get_rooms():
    return jsonify(db.get_rooms())


@app.route("/api/rooms", methods=["POST"])
def create_room():
    data = request.get_json()
    if not data or not data.get("name", "").strip():
        return jsonify({"error": "name is required"}), 400
    return jsonify(db.create_room(data["name"].strip())), 201


@app.route("/api/rooms/<int:room_id>", methods=["PUT"])
def update_room(room_id):
    data = request.get_json()
    if not data or not data.get("name", "").strip():
        return jsonify({"error": "name is required"}), 400
    room = db.update_room(room_id, data["name"].strip())
    if room is None:
        return jsonify({"error": "not found"}), 404
    return jsonify(room)


@app.route("/api/rooms/<int:room_id>", methods=["DELETE"])
def delete_room(room_id):
    db.delete_room(room_id)
    return "", 204


# ── Members ────────────────────────────────────────────────────────────────────

@app.route("/api/members", methods=["GET"])
def get_members():
    return jsonify(db.get_members())


@app.route("/api/members", methods=["POST"])
def create_member():
    data = request.get_json()
    if not data or not data.get("name", "").strip():
        return jsonify({"error": "name is required"}), 400
    return jsonify(db.create_member(data["name"].strip(), data.get("color", "#3b82f6"))), 201


@app.route("/api/members/<int:member_id>", methods=["PUT"])
def update_member(member_id):
    data = request.get_json()
    if not data or not data.get("name", "").strip():
        return jsonify({"error": "name is required"}), 400
    member = db.update_member(member_id, data["name"].strip(), data.get("color", "#3b82f6"))
    if member is None:
        return jsonify({"error": "not found"}), 404
    return jsonify(member)


@app.route("/api/members/<int:member_id>", methods=["DELETE"])
def delete_member(member_id):
    db.delete_member(member_id)
    return "", 204


# ── Tasks ──────────────────────────────────────────────────────────────────────

@app.route("/api/tasks", methods=["GET"])
def get_tasks():
    room_id = request.args.get("room_id", type=int)
    return jsonify(db.get_tasks(room_id=room_id))


@app.route("/api/tasks", methods=["POST"])
def create_task():
    data = request.get_json()
    if not data or not data.get("title", "").strip() or not data.get("room_id"):
        return jsonify({"error": "title and room_id are required"}), 400
    return jsonify(db.create_task(data)), 201


@app.route("/api/tasks/<int:task_id>", methods=["GET"])
def get_task(task_id):
    task = db.get_task(task_id)
    if task is None:
        return jsonify({"error": "not found"}), 404
    return jsonify(task)


@app.route("/api/tasks/<int:task_id>", methods=["PUT"])
def update_task(task_id):
    data = request.get_json()
    if not data or not data.get("title", "").strip():
        return jsonify({"error": "title is required"}), 400
    task = db.update_task(task_id, data)
    if task is None:
        return jsonify({"error": "not found"}), 404
    return jsonify(task)


@app.route("/api/tasks/<int:task_id>", methods=["DELETE"])
def delete_task(task_id):
    db.delete_task(task_id)
    return "", 204


@app.route("/api/tasks/<int:task_id>/complete", methods=["POST"])
def complete_task(task_id):
    data = request.get_json() or {}
    result = db.complete_task(task_id, data)
    if result is None:
        return jsonify({"error": "not found"}), 404
    return jsonify(result)


@app.route("/api/tasks/<int:task_id>/log", methods=["GET"])
def get_task_log(task_id):
    return jsonify(db.get_task_log(task_id))


@app.route("/api/streak", methods=["GET"])
def get_streak():
    return jsonify(db.get_streak())


# ── HA Notifications ───────────────────────────────────────────────────────────

SUPERVISOR_TOKEN = os.environ.get("SUPERVISOR_TOKEN", "")
HA_API = "http://supervisor/core/api"

def _ha_notify(title: str, message: str):
    """Send a persistent notification to Home Assistant."""
    if not SUPERVISOR_TOKEN:
        logger.warning("No SUPERVISOR_TOKEN — skipping notification")
        return
    try:
        _requests.post(
            f"{HA_API}/services/persistent_notification/create",
            headers={"Authorization": f"Bearer {SUPERVISOR_TOKEN}"},
            json={"title": title, "message": message, "notification_id": "household_tasks"},
            timeout=5,
        )
    except Exception as exc:
        logger.warning("HA notification failed: %s", exc)


# Read notification hour from HA add-on options (set in the Configuration tab)
# Falls back to 20 (8pm) if the options file isn't present (e.g. local dev).
def _load_notify_hour():
    import json as _json
    try:
        with open("/data/options.json") as f:
            return int(_json.load(f).get("notification_hour", 20))
    except Exception:
        return 20

NOTIFY_HOUR = _load_notify_hour()

def _notification_loop():
    """Background thread: fire one HA notification per day at NOTIFY_HOUR
    if there are overdue or due-today tasks."""
    from datetime import date, datetime
    last_notified = None

    while True:
        try:
            now = datetime.now()
            today = date.today()

            # Only notify once per day, at or after NOTIFY_HOUR
            if now.hour >= NOTIFY_HOUR and last_notified != today:
                rooms = db.get_rooms()
                overdue_total = sum(r.get("overdue_count",  0) for r in rooms)
                today_total   = sum(r.get("due_today_count", 0) for r in rooms)

                if overdue_total > 0 or today_total > 0:
                    parts = []
                    if overdue_total:
                        parts.append(f"{overdue_total} overdue task{'s' if overdue_total != 1 else ''}")
                    if today_total:
                        parts.append(f"{today_total} task{'s' if today_total != 1 else ''} due today")
                    _ha_notify(
                        "Household Tasks",
                        "⚠️ " + " and ".join(parts) + " need attention.",
                    )
                last_notified = today

        except Exception as exc:
            logger.warning("Notification check failed: %s", exc)

        # Sleep until next check — wake up every 30 min to stay close to 8am
        time.sleep(1800)


# ── Startup ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    logger.info("Initializing database…")
    db.initialize()

    # Start background notification checker
    t = threading.Thread(target=_notification_loop, daemon=True)
    t.start()

    port = int(os.environ.get("PORT", 8099))
    logger.info("Household Tasks running on port %d", port)
    app.run(host="0.0.0.0", port=port, debug=False)
