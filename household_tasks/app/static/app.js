/* ═══════════════════════════════════════════════════════
   Household Tasks — Single-page app
   ═══════════════════════════════════════════════════════ */

// ── State ──────────────────────────────────────────────────────────────────────
const state = {
  view:          "rooms",   // "rooms" | "room" | "members"
  currentRoomId: null,
  rooms:         [],
  members:       [],
  tasks:         [],        // tasks for the current room
};

// ── Ingress base path ──────────────────────────────────────────────────────────
// HA Ingress serves the app under a dynamic prefix. We read it from the <meta>
// tag injected by Flask so all API calls use the correct base URL.
const BASE = (document.querySelector('meta[name="ingress-path"]')?.content || "").replace(/\/$/, "");

// ── API helpers ────────────────────────────────────────────────────────────────
const api = {
  async _fetch(url, opts = {}) {
    const r = await fetch(BASE + url, opts);
    if (r.status === 204) return null;
    if (!r.ok) {
      const msg = await r.text().catch(() => r.statusText);
      throw new Error(msg || r.statusText);
    }
    return r.json();
  },
  get  (url)        { return this._fetch(url); },
  post (url, body)  { return this._fetch(url, { method: "POST",   headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); },
  put  (url, body)  { return this._fetch(url, { method: "PUT",    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); },
  del  (url)        { return this._fetch(url, { method: "DELETE" }); },
};

// ── Date / recurrence helpers ──────────────────────────────────────────────────
function todayStr() {
  return new Date().toISOString().split("T")[0];
}

function formatDate(iso) {
  if (!iso) return "";
  // Parse as local date to avoid timezone shifts
  const [y, m, d] = iso.split("T")[0].split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}

function getDueStatus(dueDate) {
  if (!dueDate) return "none";
  const today = new Date(todayStr());
  const due   = new Date(dueDate.split("T")[0]);
  const diff  = Math.round((due - today) / 86_400_000);
  if (diff < 0)  return "overdue";
  if (diff === 0) return "today";
  return "ok";
}

function getDueLabel(dueDate) {
  if (!dueDate) return "";
  const today = new Date(todayStr());
  const due   = new Date(dueDate.split("T")[0]);
  const diff  = Math.round((due - today) / 86_400_000);
  if (diff < 0) return `${Math.abs(diff)} day${Math.abs(diff) !== 1 ? "s" : ""} overdue`;
  if (diff === 0) return "Due today";
  if (diff === 1) return "Due tomorrow";
  if (diff <= 7)  return `Due in ${diff} days`;
  return `Due ${formatDate(dueDate)}`;
}

function formatRecurrence(type, config) {
  if (!type) return "";
  const DOW  = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
  const NTH  = ["","1st","2nd","3rd","4th","5th"];
  const v    = config.value;
  switch (type) {
    case "x_days":           return `Every ${v} day${v !== 1 ? "s" : ""}`;
    case "x_weeks":          return `Every ${v} week${v !== 1 ? "s" : ""}`;
    case "x_months":         return `Every ${v} month${v !== 1 ? "s" : ""}`;
    case "x_years":          return `Every ${v} year${v !== 1 ? "s" : ""}`;
    case "weekly_days":      return `Every week on ${(config.days || []).map(d => DOW[d]).join(", ") || "—"}`;
    case "monthly_dom":      return `Monthly on the ${config.day}${ordSuffix(config.day)}`;
    case "monthly_nth_dow":  return `Monthly on the ${NTH[config.n] || config.n} ${DOW[config.weekday]}`;
    default:                 return type;
  }
}

function ordSuffix(n) {
  if (n > 10 && n < 20) return "th";
  return ["th","st","nd","rd"][n % 10] ?? "th";
}

// ── DOM builder ────────────────────────────────────────────────────────────────
function el(tag, attrs, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null) continue;
    if (k === "className") { e.className = v; }
    else if (k === "htmlFor") { e.htmlFor = v; }
    else if (k === "style")   { e.style.cssText = v; }
    else if (k === "checked") { e.checked = !!v; }
    else if (k === "value")   { e.value = v; }
    else if (k === "rows")    { e.rows = Number(v); }
    else if (k === "selected") { e.selected = !!v; }
    else if (k.startsWith("on")) { e.addEventListener(k.slice(2).toLowerCase(), v); }
    else { e.setAttribute(k, v); }
  }
  for (const child of children.flat()) {
    if (child == null) continue;
    e.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return e;
}

// ── Navigation ─────────────────────────────────────────────────────────────────
async function navigate(view, params = {}) {
  state.view = view;
  if (params.roomId !== undefined) state.currentRoomId = params.roomId;
  showLoading();
  try {
    await loadData();
    render();
  } catch (err) {
    console.error(err);
    document.getElementById("content").innerHTML =
      `<div class="error-state">Something went wrong: ${err.message}<br>
       <button onclick="init()">Retry</button></div>`;
  }
}

async function loadData() {
  if (state.view === "rooms") {
    state.rooms = await api.get("/api/rooms");
  } else if (state.view === "room") {
    if (!state.rooms.length) state.rooms = await api.get("/api/rooms");
    state.tasks = await api.get(`/api/tasks?room_id=${state.currentRoomId}`);
  } else if (state.view === "members") {
    state.members = await api.get("/api/members");
  }
}

function showLoading() {
  document.getElementById("content").innerHTML = `<div class="loading">Loading…</div>`;
}

// ── Main render ────────────────────────────────────────────────────────────────
function render() {
  const content  = document.getElementById("content");
  const title    = document.getElementById("header-title");
  const btnBack  = document.getElementById("btn-back");
  const btnAdd   = document.getElementById("btn-add");

  btnAdd.onclick   = null;
  btnAdd.textContent = "+";
  btnAdd.style.display = "flex";

  if (state.view === "rooms") {
    title.textContent = "Household Tasks";
    btnBack.classList.add("hidden");
    btnAdd.onclick = () => showRoomModal();
    renderRoomsView(content);
    setActiveNav("rooms");

  } else if (state.view === "room") {
    const room = state.rooms.find(r => r.id === state.currentRoomId);
    title.textContent = room ? room.name : "Room";
    btnBack.classList.remove("hidden");
    btnBack.onclick = () => navigate("rooms");
    btnAdd.onclick = () => showTaskModal(null, state.currentRoomId);
    renderRoomView(content);
    setActiveNav("rooms");

  } else if (state.view === "members") {
    title.textContent = "Household Members";
    btnBack.classList.add("hidden");
    btnAdd.onclick = () => showMemberModal();
    renderMembersView(content);
    setActiveNav("members");
  }
}

function setActiveNav(active) {
  document.querySelectorAll(".nav-btn").forEach(btn =>
    btn.classList.toggle("active", btn.dataset.view === active)
  );
}

// ── Streak ─────────────────────────────────────────────────────────────────────
async function calcStreak() {
  try {
    const data = await api.get("/api/streak");
    return data.streak ?? 0;
  } catch { return null; }
}

// ── Rooms view ─────────────────────────────────────────────────────────────────
async function renderRoomsView(container) {
  container.innerHTML = "";

  // Streak banner
  const streak = await calcStreak();
  if (streak !== null) {
    const isZero = streak === 0;
    const banner = el("div", { className: `streak-banner ${isZero ? "streak-zero" : "streak-active"}` },
      el("div", { className: "streak-icon" }, isZero ? "🔴" : streak >= 7 ? "🔥" : "⚡"),
      el("div", { className: "streak-body" },
        el("div", { className: "streak-count" },
          isZero ? "Streak broken" : String(streak),
          isZero ? null : el("span", {}, `day${streak !== 1 ? "s" : ""}`),
        ),
        el("div", { className: "streak-sub" },
          isZero ? "A task is currently overdue" : "Since last overdue task",
        ),
      ),
    );
    container.append(banner);
  }

  if (!state.rooms.length) {
    container.append(el("div", { className: "empty-state" },
      el("div", { className: "empty-icon" }, "🏠"),
      el("p",   { className: "empty-title" }, "No rooms yet"),
      el("p",   { className: "empty-sub"   }, "Tap + to add your first room"),
    ));
    return;
  }

  const grid = el("div", { className: "rooms-grid" });

  for (const room of state.rooms) {
    const statusClass =
      room.overdue_count  > 0 ? "status-overdue" :
      room.due_soon_count > 0 ? "status-soon"    : "status-ok";

    const badge =
      room.overdue_count  > 0 ? el("span", { className: "badge badge-red"    }, String(room.overdue_count))  :
      room.due_soon_count > 0 ? el("span", { className: "badge badge-yellow" }, String(room.due_soon_count)) :
      null;

    const card = el("div", { className: `room-card ${statusClass}`,
                              onClick: () => navigate("room", { roomId: room.id }) },
      el("div", { className: "room-card-header" },
        el("h3", { className: "room-name" }, room.name),
        badge,
      ),
      el("p", { className: "room-meta" },
        `${room.task_count} task${room.task_count !== 1 ? "s" : ""}`
      ),
      el("div", { className: "room-actions" },
        el("button", { className: "btn-icon-sm", title: "Edit room",
                       onClick: e => { e.stopPropagation(); showRoomModal(room); } }, "✎"),
        el("button", { className: "btn-icon-sm btn-danger", title: "Delete room",
                       onClick: e => { e.stopPropagation(); confirmDeleteRoom(room); } }, "🗑"),
      ),
    );
    grid.append(card);
  }

  container.append(grid);
}

// ── Complete-button animation ──────────────────────────────────────────────────
function animateComplete(btn, taskEl) {
  btn.classList.add("completing");
  btn.addEventListener("animationend", () => btn.classList.remove("completing"), { once: true });
  setTimeout(() => taskEl.classList.add("task-sliding-out"), 160);
}

// ── Room (tasks) view ──────────────────────────────────────────────────────────
function renderRoomView(container) {
  container.innerHTML = "";

  if (!state.tasks.length) {
    container.append(el("div", { className: "empty-state" },
      el("div", { className: "empty-icon" }, "✅"),
      el("p",   { className: "empty-title" }, "No tasks yet"),
      el("p",   { className: "empty-sub"   }, "Tap + to add the first task"),
    ));
    return;
  }

  const list = el("div", { className: "task-list" });

  for (const task of state.tasks) {
    const status   = getDueStatus(task.due_date);
    const dueLabel = getDueLabel(task.due_date);
    const recLabel = task.is_recurring && task.recurrence_type
      ? formatRecurrence(task.recurrence_type, JSON.parse(task.recurrence_config || "{}"))
      : null;

    const item = el("div", { className: `task-item task-${status}` },
      el("div", { className: "task-main" },
        el("div", { className: "task-info" },
          el("div", { className: "task-title" }, task.title),
          task.description
            ? el("div", { className: "task-desc" }, task.description)
            : null,
          el("div", { className: "task-meta" },
            dueLabel
              ? el("span", { className: `task-due due-${status}` }, dueLabel)
              : null,
            recLabel
              ? el("span", { className: "task-recur" }, "↻ " + recLabel)
              : null,
            task.member_name
              ? el("span", {
                  className: "task-member",
                  style: `background:${task.member_color}22;color:${task.member_color}`,
                }, task.member_name)
              : null,
          ),
        ),
        el("div", { className: "task-actions" },
          el("button", { className: "btn-complete", title: "Mark complete",
                         onClick: e => { e.stopPropagation(); animateComplete(e.currentTarget, item); showCompleteModal(task); } }, "✓"),
          el("button", { className: "btn-icon-sm", title: "Edit task",
                         onClick: e => { e.stopPropagation(); showTaskModal(task, task.room_id); } }, "✎"),
          el("button", { className: "btn-icon-sm", title: "History",
                         onClick: e => { e.stopPropagation(); showTaskLog(task); } }, "📋"),
          el("button", { className: "btn-icon-sm btn-danger", title: "Delete task",
                         onClick: e => { e.stopPropagation(); confirmDeleteTask(task); } }, "🗑"),
        ),
      ),
    );
    list.append(item);
  }

  container.append(list);
}

// ── Members view ───────────────────────────────────────────────────────────────
function renderMembersView(container) {
  container.innerHTML = "";

  if (!state.members.length) {
    container.append(el("div", { className: "empty-state" },
      el("div", { className: "empty-icon" }, "👥"),
      el("p",   { className: "empty-title" }, "No members yet"),
      el("p",   { className: "empty-sub"   }, "Tap + to add household members"),
    ));
    return;
  }

  const list = el("div", { className: "member-list" });

  for (const member of state.members) {
    list.append(el("div", { className: "member-item" },
      el("div", { className: "member-avatar", style: `background:${member.color}` },
        member.name.charAt(0).toUpperCase()
      ),
      el("span", { className: "member-name" }, member.name),
      el("div",  { className: "member-actions" },
        el("button", { className: "btn-icon-sm",
                       onClick: () => showMemberModal(member) }, "✎"),
        el("button", { className: "btn-icon-sm btn-danger",
                       onClick: () => confirmDeleteMember(member) }, "🗑"),
      ),
    ));
  }

  container.append(list);
}

// ── Modal system ───────────────────────────────────────────────────────────────
function showModal(title, bodyEl, actions) {
  const overlay = document.getElementById("modal-overlay");
  const modal   = document.getElementById("modal");

  modal.innerHTML = "";
  modal.append(
    el("div", { className: "modal-header" },
      el("h2", { className: "modal-title" }, title),
      el("button", { className: "modal-close", onClick: closeModal }, "✕"),
    ),
    el("div", { className: "modal-body"   }, bodyEl),
    el("div", { className: "modal-footer" }, ...actions),
  );

  overlay.classList.remove("hidden");
  overlay.onclick = e => { if (e.target === overlay) closeModal(); };
}

function closeModal() {
  document.getElementById("modal-overlay").classList.add("hidden");
}

// ── Room modal ─────────────────────────────────────────────────────────────────
function showRoomModal(room = null) {
  const form = el("div", {},
    el("label", { className: "form-label", htmlFor: "room-name" }, "Room name"),
    el("input", {
      type: "text", id: "room-name", className: "form-input",
      placeholder: "e.g. Kitchen, Living Room…",
      value: room ? room.name : "",
    }),
  );

  showModal(room ? "Edit Room" : "Add Room", form, [
    el("button", { className: "btn btn-secondary", onClick: closeModal }, "Cancel"),
    el("button", {
      className: "btn btn-primary",
      onClick: async () => {
        const name = document.getElementById("room-name").value.trim();
        if (!name) return;
        try {
          if (room) await api.put(`/api/rooms/${room.id}`, { name });
          else       await api.post("/api/rooms", { name });
          closeModal();
          await navigate("rooms");
        } catch (err) { alert(err.message); }
      },
    }, room ? "Save" : "Add Room"),
  ]);

  setTimeout(() => document.getElementById("room-name")?.focus(), 100);
}

async function confirmDeleteRoom(room) {
  if (!confirm(`Delete "${room.name}" and all its tasks? This cannot be undone.`)) return;
  await api.del(`/api/rooms/${room.id}`);
  await navigate("rooms");
}

// ── Member modal ───────────────────────────────────────────────────────────────
const COLORS = [
  "#ef4444","#f97316","#eab308","#22c55e",
  "#3b82f6","#8b5cf6","#ec4899","#14b8a6",
];

function showMemberModal(member = null) {
  let selectedColor = member ? member.color : COLORS[0];

  const picker = el("div", { className: "color-picker" });
  COLORS.forEach(c => {
    const dot = el("button", {
      type: "button",
      className: "color-dot" + (c === selectedColor ? " selected" : ""),
      style: `background:${c}`,
      onClick: () => {
        selectedColor = c;
        picker.querySelectorAll(".color-dot").forEach(d => d.classList.remove("selected"));
        dot.classList.add("selected");
      },
    });
    picker.append(dot);
  });

  const body = el("div", {},
    el("label", { className: "form-label", htmlFor: "member-name" }, "Name"),
    el("input", {
      type: "text", id: "member-name", className: "form-input",
      placeholder: "e.g. Alex, Taylor…",
      value: member ? member.name : "",
    }),
    el("label", { className: "form-label" }, "Color"),
    picker,
  );

  showModal(member ? "Edit Member" : "Add Member", body, [
    el("button", { className: "btn btn-secondary", onClick: closeModal }, "Cancel"),
    el("button", {
      className: "btn btn-primary",
      onClick: async () => {
        const name = document.getElementById("member-name").value.trim();
        if (!name) return;
        try {
          if (member) await api.put(`/api/members/${member.id}`, { name, color: selectedColor });
          else         await api.post("/api/members", { name, color: selectedColor });
          closeModal();
          await navigate("members");
        } catch (err) { alert(err.message); }
      },
    }, member ? "Save" : "Add Member"),
  ]);

  setTimeout(() => document.getElementById("member-name")?.focus(), 100);
}

async function confirmDeleteMember(member) {
  if (!confirm(`Delete "${member.name}"? Their tasks will become unassigned.`)) return;
  await api.del(`/api/members/${member.id}`);
  await navigate("members");
}

// ── Task modal ─────────────────────────────────────────────────────────────────
async function showTaskModal(task = null, roomId = null) {
  if (!state.members.length) {
    state.members = await api.get("/api/members");
  }

  // Recurrence state — closure variable updated by the UI
  let recConfig = task && task.recurrence_config
    ? JSON.parse(task.recurrence_config) : {};

  // Build the detail section for the chosen recurrence type
  function buildRecurDetail(container, type) {
    container.innerHTML = "";
    if (!type) return;

    if (["x_days","x_weeks","x_months","x_years"].includes(type)) {
      const unit = { x_days:"day(s)", x_weeks:"week(s)", x_months:"month(s)", x_years:"year(s)" }[type];
      container.append(el("div", { className: "recur-row" },
        el("span", { className: "recur-unit" }, "Every"),
        el("input", {
          type: "number", id: "recur-value", className: "form-input recur-num",
          value: String(recConfig.value ?? 1), min: "1", max: "365",
        }),
        el("span", { className: "recur-unit" }, unit),
      ));
    }

    else if (type === "weekly_days") {
      const DAY_SHORT = ["M","T","W","T","F","S","S"];
      const DAY_FULL  = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
      const sel = new Set(recConfig.days || []);

      const picker = el("div", { className: "day-picker" });
      DAY_SHORT.forEach((d, i) => {
        const btn = el("button", {
          type: "button",
          className: "day-btn" + (sel.has(i) ? " selected" : ""),
          title: DAY_FULL[i],
          onClick: () => {
            sel.has(i) ? sel.delete(i) : sel.add(i);
            btn.classList.toggle("selected", sel.has(i));
            recConfig.days = [...sel].sort((a,b) => a - b);
          },
        }, d);
        picker.append(btn);
      });
      recConfig.days = [...sel].sort((a,b) => a - b);
      container.append(
        el("div", {},
          el("label", { className: "form-label" }, "On these days"),
          picker,
        )
      );
    }

    else if (type === "monthly_dom") {
      container.append(el("div", { className: "recur-row" },
        el("span", { className: "recur-unit" }, "On day"),
        el("input", {
          type: "number", id: "recur-dom", className: "form-input recur-num",
          value: String(recConfig.day ?? 1), min: "1", max: "31",
        }),
        el("span", { className: "recur-unit" }, "of each month"),
      ));
    }

    else if (type === "monthly_nth_dow") {
      const nthOpts = ["1st","2nd","3rd","4th","5th"];
      const dowOpts = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];

      const nthSel = el("select", { id: "recur-nth", className: "form-select" },
        ...nthOpts.map((o, i) => el("option", { value: String(i+1), selected: (recConfig.n ?? 1) === i+1 }, o))
      );
      const dowSel = el("select", { id: "recur-dow", className: "form-select" },
        ...dowOpts.map((o, i) => el("option", { value: String(i), selected: (recConfig.weekday ?? 0) === i }, o))
      );

      container.append(el("div", { className: "recur-row" },
        el("span", { className: "recur-unit" }, "The"),
        nthSel,
        dowSel,
        el("span", { className: "recur-unit" }, "of each month"),
      ));
    }
  }

  const recurDetail = el("div", {});

  const RECUR_TYPES = [
    ["x_days",          "Every X days"],
    ["x_weeks",         "Every X weeks"],
    ["x_months",        "Every X months"],
    ["x_years",         "Every X years"],
    ["weekly_days",     "Every week on specific days"],
    ["monthly_dom",     "Monthly on day # of month"],
    ["monthly_nth_dow", "Monthly on Nth weekday"],
  ];

  const recurTypeSelect = el("select", {
    id: "recur-type", className: "form-select",
    onChange: e => {
      recConfig = {};
      buildRecurDetail(recurDetail, e.target.value);
    },
  }, ...RECUR_TYPES.map(([v, l]) =>
    el("option", { value: v, selected: task?.recurrence_type === v }, l)
  ));

  const initRecurType = task?.recurrence_type || "x_days";
  buildRecurDetail(recurDetail, initRecurType);

  const isRec = task ? !!(task.is_recurring) : true;
  const recurGroup = el("div", {
    id: "recur-group", className: "recur-group",
    style: isRec ? "" : "display:none",
  },
    el("label", { className: "form-label" }, "Repeats"),
    recurTypeSelect,
    recurDetail,
  );

  const recurToggle = el("input", {
    type: "checkbox", id: "is-recurring",
    checked: isRec,
    onChange: e => { recurGroup.style.display = e.target.checked ? "" : "none"; },
  });

  // Member select
  const memberSelect = el("select", { id: "task-member", className: "form-select" },
    el("option", { value: "" }, "— None —"),
    ...state.members.map(m =>
      el("option", { value: String(m.id), selected: task?.assigned_member_id === m.id }, m.name)
    ),
  );

  // Room select (shown when editing so you can reassign)
  const roomSelect = el("select", { id: "task-room", className: "form-select" },
    ...state.rooms.map(r =>
      el("option", { value: String(r.id), selected: (task ? task.room_id : roomId) === r.id }, r.name)
    ),
  );

  const bodyParts = [
    task ? el("label", { className: "form-label", htmlFor: "task-room" }, "Room") : null,
    task ? roomSelect : null,
    el("label", { className: "form-label", htmlFor: "task-title" }, "Title *"),
    el("input", {
      type: "text", id: "task-title", className: "form-input",
      placeholder: "e.g. Vacuum floors",
      value: task ? task.title : "",
    }),
    el("label", { className: "form-label", htmlFor: "task-desc" }, "Description"),
    el("textarea", {
      id: "task-desc", className: "form-input", rows: "2",
      placeholder: "Optional notes…",
    }, task?.description || ""),
    el("label", { className: "form-label", htmlFor: "task-member" }, "Assigned to"),
    memberSelect,
    el("label", { className: "form-label", htmlFor: "task-due" }, "Due date"),
    el("input", {
      type: "date", id: "task-due", className: "form-input",
      value: task?.due_date ? task.due_date.split("T")[0] : "",
    }),
    el("div", { className: "form-toggle" },
      recurToggle,
      el("label", { className: "toggle-label", htmlFor: "is-recurring" }, "Recurring task"),
    ),
    recurGroup,
  ];

  const body = el("div", {}, ...bodyParts.filter(Boolean));

  function collectRecurrence() {
    const type = document.getElementById("recur-type")?.value;
    if (!type) return { type: null, config: null };
    const cfg = {};
    if (["x_days","x_weeks","x_months","x_years"].includes(type)) {
      cfg.value = parseInt(document.getElementById("recur-value")?.value || "1", 10);
    } else if (type === "weekly_days") {
      cfg.days = recConfig.days || [];
    } else if (type === "monthly_dom") {
      cfg.day = parseInt(document.getElementById("recur-dom")?.value || "1", 10);
    } else if (type === "monthly_nth_dow") {
      cfg.n       = parseInt(document.getElementById("recur-nth")?.value || "1", 10);
      cfg.weekday = parseInt(document.getElementById("recur-dow")?.value || "0", 10);
    }
    return { type, config: cfg };
  }

  showModal(task ? "Edit Task" : "Add Task", body, [
    el("button", { className: "btn btn-secondary", onClick: closeModal }, "Cancel"),
    el("button", {
      className: "btn btn-primary",
      onClick: async () => {
        const title = document.getElementById("task-title").value.trim();
        if (!title) { alert("Title is required"); return; }

        const recurring = document.getElementById("is-recurring")?.checked;
        const { type: recType, config: recConf } = recurring ? collectRecurrence() : {};

        const payload = {
          room_id:            task
            ? parseInt(document.getElementById("task-room").value, 10)
            : roomId,
          title,
          description:        document.getElementById("task-desc").value.trim() || null,
          assigned_member_id: document.getElementById("task-member").value
            ? parseInt(document.getElementById("task-member").value, 10) : null,
          due_date:           document.getElementById("task-due").value || null,
          is_recurring:       !!recurring,
          recurrence_type:    recurring ? recType  : null,
          recurrence_config:  recurring ? recConf  : null,
        };

        try {
          if (task) await api.put(`/api/tasks/${task.id}`, payload);
          else       await api.post("/api/tasks", payload);
          closeModal();
          await navigate("room", { roomId: state.currentRoomId });
        } catch (err) { alert(err.message); }
      },
    }, task ? "Save" : "Add Task"),
  ]);

  setTimeout(() => document.getElementById("task-title")?.focus(), 100);
}

async function confirmDeleteTask(task) {
  if (!confirm(`Delete "${task.title}"? This cannot be undone.`)) return;
  await api.del(`/api/tasks/${task.id}`);
  await navigate("room", { roomId: state.currentRoomId });
}

// ── Complete task modal ────────────────────────────────────────────────────────
async function showCompleteModal(task) {
  if (!state.members.length) {
    state.members = await api.get("/api/members");
  }

  // Local datetime default (strips timezone offset so the input shows local time)
  const now = new Date();
  const localDT = new Date(now - now.getTimezoneOffset() * 60_000)
    .toISOString().slice(0, 16);

  const memberSelect = el("select", { id: "complete-member", className: "form-select" },
    el("option", { value: "" }, "— None —"),
    ...state.members.map(m => el("option", { value: String(m.id) }, m.name)),
  );

  const recurNote = task.is_recurring && task.recurrence_type
    ? el("p", { className: "recur-notice" },
        `↻ Next due date will be recalculated (${
          formatRecurrence(task.recurrence_type, JSON.parse(task.recurrence_config || "{}"))
        })`)
    : null;

  const body = el("div", {},
    el("div", { className: "complete-task-name" }, task.title),
    el("label", { className: "form-label", htmlFor: "complete-member" }, "Completed by"),
    memberSelect,
    el("label", { className: "form-label", htmlFor: "complete-time" }, "Completed at"),
    el("input", { type: "datetime-local", id: "complete-time", className: "form-input", value: localDT }),
    el("label", { className: "form-label", htmlFor: "complete-notes" }, "Notes"),
    el("textarea", { id: "complete-notes", className: "form-input", rows: "2", placeholder: "Optional…" }, ""),
    recurNote,
  );

  showModal("Mark Task Complete", body, [
    el("button", { className: "btn btn-secondary", onClick: closeModal }, "Cancel"),
    el("button", {
      className: "btn btn-success",
      onClick: async () => {
        const timeVal   = document.getElementById("complete-time").value;
        const memberVal = document.getElementById("complete-member").value;
        const notesVal  = document.getElementById("complete-notes").value.trim();
        try {
          await api.post(`/api/tasks/${task.id}/complete`, {
            completed_at: timeVal ? new Date(timeVal).toISOString() : null,
            member_id:    memberVal ? parseInt(memberVal, 10) : null,
            notes:        notesVal || null,
          });
          closeModal();
          await navigate("room", { roomId: state.currentRoomId });
        } catch (err) { alert(err.message); }
      },
    }, "✓ Mark Complete"),
  ]);
}

// ── Task log modal ─────────────────────────────────────────────────────────────
async function showTaskLog(task) {
  const log  = await api.get(`/api/tasks/${task.id}/log`);
  let body;

  if (!log.length) {
    body = el("p", { className: "log-empty" }, "No completions recorded yet.");
  } else {
    body = el("div", { className: "log-list" },
      ...log.map(entry => {
        const dt = new Date(entry.completed_at);
        return el("div", { className: "log-entry" },
          el("div", { className: "log-info" },
            el("span", { className: "log-date" }, dt.toLocaleString()),
            entry.member_name
              ? el("span", {
                  className: "log-member",
                  style: `background:${entry.member_color}22;color:${entry.member_color}`,
                }, entry.member_name)
              : null,
          ),
          entry.notes ? el("p", { className: "log-notes" }, entry.notes) : null,
        );
      })
    );
  }

  showModal(`History: ${task.title}`, body, [
    el("button", { className: "btn btn-secondary", onClick: closeModal }, "Close"),
  ]);
}

// ── Init ───────────────────────────────────────────────────────────────────────
document.querySelectorAll(".nav-btn").forEach(btn =>
  btn.addEventListener("click", () => navigate(btn.dataset.view))
);

async function init() {
  await navigate("rooms");
}

init().catch(console.error);
