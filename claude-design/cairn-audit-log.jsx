/* Audit Log modal — chronological, signed event stream for a room
   Scope: this room. Surfaces capability grants, message events,
   call lifecycle, member changes, transport switches, and key events. */

const { Icon: IA, CAIRN: CA } = window;
const PA = CA.PEOPLE;

const _useEscA = (onClose) => {
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
};

const _avA = (id, size = 22) => {
  const p = PA[id];
  if (!p) return <div className="al-av sys" style={{ width: size, height: size }}>SY</div>;
  if (p.kind === "agent") return <div className="al-av agent" style={{ width: size, height: size }}>{p.short}</div>;
  return <div className="al-av" style={{ width: size, height: size, background: p.color }}>{p.initials}</div>;
};

/* ---- Event categories ---- */
const CATEGORIES = {
  capability: { label: "Capability", icon: "shield", tint: "warn" },
  message:    { label: "Message",    icon: "send",   tint: "neutral" },
  member:     { label: "Member",     icon: "users",  tint: "accent" },
  call:       { label: "Call",       icon: "phone",  tint: "pos" },
  poll:       { label: "Poll",       icon: "check",  tint: "accent" },
  task:       { label: "Task",       icon: "bolt",   tint: "pos" },
  system:     { label: "System",     icon: "info",   tint: "neutral" },
};

/* ---- Deterministic short-hash for a "signed" event id ---- */
const _hash = (s) => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ("00000000" + (h >>> 0).toString(16)).slice(-8);
};

/* ---- Synthesize events for a room ----
   Combines a curated historical baseline with events derived from current messages. */
const buildEvents = (room) => {
  const sig = (...parts) => _hash(parts.join("|"));
  const evs = [];

  /* ---- Today, derived from messages (forward order, newest last) ---- */
  for (const m of room.messages) {
    const from = m.from;
    const t = m.t;
    if (m.inlay?.kind === "approval") {
      const ap = m.inlay;
      evs.push({
        id: "ev_" + sig("apr_req", m.id, t),
        day: "today", t, kind: "capability", severity: "warn", actor: from,
        title: "Capability requested",
        summary: `${PA[from]?.name ?? from} requested \`${ap.capability}\``,
        meta: { scope: ap.scope, expiresAt: ap.expiresAt, transport: "lan" },
        signed: true,
      });
      if (ap.state === "approved" || ap.state === "denied") {
        evs.push({
          id: "ev_" + sig("apr_res", m.id, ap.state),
          day: "today", t,
          kind: "capability",
          severity: ap.state === "approved" ? "pos" : "neg",
          actor: "u_me",
          title: ap.state === "approved" ? "Capability granted" : "Capability denied",
          summary: `${PA.u_me?.name ?? "you"} ${ap.state === "approved" ? "granted" : "denied"} \`${ap.capability}\` to ${PA[from]?.name ?? from}`,
          meta: { scope: ap.scope, transport: "lan", policy: "owner-only" },
          signed: true,
        });
      }
    } else if (m.inlay?.kind === "poll") {
      const p = m.inlay;
      evs.push({
        id: "ev_" + sig("poll_new", m.id),
        day: "today", t, kind: "poll", severity: "info",
        actor: p.createdBy ?? from,
        title: "Poll created",
        summary: `\u201c${p.question}\u201d \u00b7 ${p.options.length} options`,
        meta: { closesAt: p.closesAt, transport: "lan" },
        signed: true,
      });
      for (const a of (p.activity ?? [])) {
        if (a.what.startsWith("voted")) {
          evs.push({
            id: "ev_" + sig("poll_vote", m.id, a.who, a.t),
            day: "today", t: a.t, kind: "poll", severity: "info",
            actor: a.who,
            title: "Vote cast",
            summary: `${PA[a.who]?.name ?? a.who} ${a.what}`,
            meta: { transport: "lan" },
            signed: true,
          });
        }
      }
    } else if (m.inlay?.kind === "task-card") {
      const d = m.inlay.detail ?? {};
      evs.push({
        id: "ev_" + sig("task", m.id),
        day: "today", t: d.endedAt ?? t, kind: "task", severity: "pos",
        actor: from,
        title: "Task completed",
        summary: `${PA[from]?.name ?? from} finished \u201c${m.inlay.title.replace(/\s*\u2014\s*done$/, "")}\u201d`,
        meta: {
          duration: d.durationSec ? `${Math.round(d.durationSec / 60)}m ${d.durationSec % 60}s` : null,
          capabilities: (d.capabilities ?? []).map(c => c.name).join(", "),
          transport: "lan",
        },
        signed: true,
      });
      if (d.startedAt) {
        evs.push({
          id: "ev_" + sig("task_start", m.id),
          day: "today", t: d.startedAt, kind: "task", severity: "info",
          actor: from,
          title: "Task started",
          summary: `${PA[from]?.name ?? from} began \u201c${m.inlay.title.replace(/\s*\u2014\s*done$/, "")}\u201d`,
          meta: {
            requestedBy: d.requestedBy ? (PA[d.requestedBy]?.name ?? d.requestedBy) : null,
            transport: "lan",
          },
          signed: true,
        });
      }
    } else if (m.inlay?.kind === "call") {
      const c = m.inlay;
      evs.push({
        id: "ev_" + sig("call_start", m.id),
        day: "today", t, kind: "call",
        severity: c.state === "missed" ? "neg" : "pos",
        actor: c.startedBy ?? from,
        title: c.state === "missed" ? "Call missed" : (c.state === "ringing" ? "Call ringing" : "Call started"),
        summary: `${PA[c.startedBy ?? from]?.name ?? from} \u2192 ${c.participants.length} participants`,
        meta: {
          participants: c.participants.map(p => PA[p.id]?.name ?? p.id).join(", "),
          transport: room.transport,
        },
        signed: true,
      });
      if (c.state === "ended") {
        evs.push({
          id: "ev_" + sig("call_end", m.id),
          day: "today", t: c.endedAtLabel ?? t, kind: "call", severity: "info",
          actor: "u_me",
          title: "Call ended",
          summary: c.duration != null ? `Duration ${Math.floor(c.duration / 60)}m ${c.duration % 60}s` : "Call ended",
          meta: { transport: room.transport },
          signed: true,
        });
      }
    } else if (m.text) {
      evs.push({
        id: "ev_" + sig("msg", m.id),
        day: "today", t, kind: "message", severity: "info",
        actor: from,
        title: "Message sent",
        summary: `${PA[from]?.name ?? from}: \u201c${m.text.length > 76 ? m.text.slice(0, 76) + "\u2026" : m.text}\u201d`,
        meta: { transport: m.transport ?? "lan", state: m.state ?? "delivered" },
        signed: true,
      });
    }
  }

  /* ---- Yesterday, room-flavored baseline ---- */
  if (room.id === "r_garden") {
    evs.unshift(
      { id: "ev_" + sig("y", "task1"),    day: "yesterday", t: "18:42", kind: "task", severity: "pos",
        actor: "a_garden", title: "Task completed",
        summary: "Garden ran \u201cWater beds 1\u20132 (light)\u201d to completion",
        meta: { duration: "8m 12s", capabilities: "valve.actuate(bed_1), valve.actuate(bed_2)", transport: "lan" },
        signed: true },
      { id: "ev_" + sig("y", "grant1"),  day: "yesterday", t: "18:34", kind: "capability", severity: "pos",
        actor: "u_me", title: "Capability granted",
        summary: "Aaron granted `valve.actuate(bed_1, bed_2)` to Garden",
        meta: { scope: "15 min \u00b7 these actuators only", policy: "owner-only", transport: "lan" },
        signed: true },
      { id: "ev_" + sig("y", "exp1"),    day: "yesterday", t: "18:49", kind: "capability", severity: "info",
        actor: "system", title: "Capability auto-revoked",
        summary: "`valve.actuate(bed_1, bed_2)` reached its 15-minute scope and was revoked",
        meta: { reason: "ttl expired", transport: "lan" },
        signed: true },
      { id: "ev_" + sig("y", "trans1"),  day: "yesterday", t: "16:08", kind: "system", severity: "info",
        actor: "system", title: "Transport switched",
        summary: "Auto fell back from LAN to mesh while #garden was off-network",
        meta: { reason: "lan unreachable 6s", transport: "mesh" },
        signed: false },
    );
  } else if (room.id === "r_ops") {
    evs.unshift(
      { id: "ev_" + sig("y", "backup"),  day: "yesterday", t: "03:14", kind: "system", severity: "pos",
        actor: "a_ops", title: "Nightly backup",
        summary: "Ops snapshotted room state \u2192 `op-snap-0524-03`",
        meta: { bytes: "4.2 MB", target: "household.local", transport: "lan" },
        signed: true },
      { id: "ev_" + sig("y", "rot"),     day: "yesterday", t: "03:14", kind: "system", severity: "info",
        actor: "system", title: "Key rotated",
        summary: "Room signing key rotated on schedule",
        meta: { algo: "Ed25519", interval: "24h" },
        signed: true },
    );
  } else if (room.id === "r_family") {
    evs.unshift(
      { id: "ev_" + sig("y", "join"),    day: "yesterday", t: "21:02", kind: "member", severity: "info",
        actor: "u_kai", title: "Member joined room",
        summary: "Kai rejoined from a new device (laptop \u00b7 fingerprint matched)",
        meta: { device: "kai-laptop \u00b7 verified", transport: "lan" },
        signed: true },
    );
  } else if (room.id === "r_neighbors") {
    evs.unshift(
      { id: "ev_" + sig("y", "xh"),      day: "yesterday", t: "19:31", kind: "member", severity: "warn",
        actor: "u_sam", title: "Cross-household joined",
        summary: "Sam (sister's household) accepted block-watch invite",
        meta: { policy: "cross-household acknowledged", transport: "mesh" },
        signed: true },
    );
  }

  /* ---- Two days ago, room-creation baseline ---- */
  evs.unshift({
    id: "ev_" + sig("c", room.id), day: "earlier", t: "Mon 14:22",
    kind: "member", severity: "info", actor: "u_me",
    title: "Room created",
    summary: `Aaron created ${room.glyph}${room.name}`,
    meta: { transport: "lan", policy: "owner-only" },
    signed: true,
  });

  /* sort: earlier -> yesterday -> today; within day by t */
  const dayOrder = { earlier: 0, yesterday: 1, today: 2 };
  const tKey = (t) => {
    const parts = String(t).match(/(\d{1,2}):(\d{2})/);
    if (!parts) return 0;
    return (+parts[1]) * 60 + (+parts[2]);
  };
  evs.sort((a, b) => {
    const d = dayOrder[a.day] - dayOrder[b.day];
    if (d !== 0) return d;
    return tKey(a.t) - tKey(b.t);
  });

  return evs;
};

/* ---- Severity dot ---- */
const sevColor = (sev) => {
  if (sev === "pos")  return "var(--pos)";
  if (sev === "neg")  return "var(--neg)";
  if (sev === "warn") return "var(--warn)";
  return "var(--text-4)";
};

/* ============ Audit Log Modal ============ */
const AuditLogModal = ({ room, onClose }) => {
  _useEscA(onClose);
  const events = React.useMemo(() => buildEvents(room), [room.id, room.messages.length, JSON.stringify(room.messages.map(m => m.inlay?.state ?? null))]);

  const [query, setQuery]   = React.useState("");
  const [active, setActive] = React.useState("all"); /* category filter */
  const [openIds, setOpenIds] = React.useState({}); /* expanded rows */
  const toggleOpen = (id) => setOpenIds(prev => ({ ...prev, [id]: !prev[id] }));

  /* Counts per category */
  const counts = events.reduce((acc, e) => {
    acc[e.kind] = (acc[e.kind] ?? 0) + 1;
    return acc;
  }, {});

  /* Filter */
  const filtered = events.filter(e => {
    if (active !== "all" && e.kind !== active) return false;
    if (!query) return true;
    const q = query.toLowerCase();
    return (
      e.title.toLowerCase().includes(q) ||
      e.summary.toLowerCase().includes(q) ||
      (PA[e.actor]?.name ?? "").toLowerCase().includes(q) ||
      e.id.toLowerCase().includes(q)
    );
  });

  /* Group by day */
  const grouped = {};
  for (const e of filtered) {
    (grouped[e.day] ??= []).push(e);
  }
  const dayLabel = (d) => d === "today" ? "Today" : d === "yesterday" ? "Yesterday" : "Earlier this week";
  const dayOrder = ["earlier", "yesterday", "today"];

  /* Summary stats */
  const stats = {
    grants:    events.filter(e => e.kind === "capability" && /granted|approved/i.test(e.title)).length,
    denied:    events.filter(e => e.kind === "capability" && /denied/i.test(e.title)).length,
    revokes:   events.filter(e => e.kind === "capability" && /revok/i.test(e.title)).length,
    messages:  counts.message ?? 0,
    calls:     counts.call ?? 0,
  };

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal detail al-modal" onClick={(e) => e.stopPropagation()}>

        <div className="m-head">
          <div className="lockup">
            <div className="icon-wrap audit"><IA name="logs" size={18}/></div>
            <div>
              <h2>Audit log · {room.glyph}{room.name}</h2>
              <div className="sub">
                <span>{events.length} events</span>
                <span className="dot"/>
                <span>local-first, signed</span>
                <span className="dot"/>
                <span style={{ fontFamily: "var(--font-mono)" }}>chain-tip {_hash(room.id + events.length).slice(0, 8)}</span>
              </div>
            </div>
          </div>
          <button className="x" onClick={onClose}><IA name="x" size={14}/></button>
        </div>

        {/* Summary strip */}
        <div className="al-stats">
          <div className="al-stat">
            <div className="al-stat-v">{stats.grants}</div>
            <div className="al-stat-k">grants</div>
          </div>
          <div className="al-stat-div"/>
          <div className="al-stat">
            <div className="al-stat-v" style={{ color: stats.denied ? "var(--neg)" : "var(--text-3)" }}>{stats.denied}</div>
            <div className="al-stat-k">denied</div>
          </div>
          <div className="al-stat-div"/>
          <div className="al-stat">
            <div className="al-stat-v">{stats.revokes}</div>
            <div className="al-stat-k">auto-revoked</div>
          </div>
          <div className="al-stat-div"/>
          <div className="al-stat">
            <div className="al-stat-v">{stats.messages}</div>
            <div className="al-stat-k">messages</div>
          </div>
          <div className="al-stat-div"/>
          <div className="al-stat">
            <div className="al-stat-v">{stats.calls}</div>
            <div className="al-stat-k">calls</div>
          </div>
          <span className="grow"/>
          <div className="al-stat al-verify">
            <span className="al-pip"/>
            <span>integrity ok</span>
          </div>
        </div>

        {/* Toolbar */}
        <div className="al-toolbar">
          <div className="al-search">
            <IA name="search" size={13}/>
            <input
              placeholder="Search events, actors, capabilities, ids…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
          </div>
          <div className="al-chips">
            <button
              className="al-chip"
              data-active={active === "all"}
              onClick={() => setActive("all")}
            >
              All
              <span className="al-chip-c">{events.length}</span>
            </button>
            {Object.entries(CATEGORIES).map(([key, cat]) => (
              counts[key] ? (
                <button
                  key={key}
                  className={"al-chip kind-" + key}
                  data-active={active === key}
                  onClick={() => setActive(key)}
                  title={cat.label}
                >
                  <IA name={cat.icon} size={11}/>
                  <span>{cat.label}</span>
                  <span className="al-chip-c">{counts[key]}</span>
                </button>
              ) : null
            ))}
          </div>
        </div>

        {/* Event list */}
        <div className="m-body al-body">
          {filtered.length === 0 && (
            <div style={{ padding: "60px 22px", textAlign: "center", color: "var(--text-3)" }}>
              <div style={{ fontSize: 13 }}>No matching events.</div>
              <div style={{ fontSize: 12, marginTop: 4 }}>Try clearing the filter or search.</div>
            </div>
          )}

          {dayOrder.map(day => grouped[day] && (
            <div className="al-day" key={day}>
              <div className="al-day-head">
                <span>{dayLabel(day)}</span>
                <span className="al-day-c">{grouped[day].length}</span>
              </div>
              <div className="al-list">
                {grouped[day].map((e, i) => {
                  const cat = CATEGORIES[e.kind];
                  const open = !!openIds[e.id];
                  const last = i === grouped[day].length - 1;
                  return (
                    <div className={"al-row kind-" + e.kind + " sev-" + e.severity} key={e.id} data-last={last}>
                      <div className="al-rail">
                        <div className="al-rail-line"/>
                        <div className="al-rail-dot" style={{ background: sevColor(e.severity) }}>
                          <IA name={cat.icon} size={9}/>
                        </div>
                      </div>
                      <div className="al-row-body">
                        <button
                          className="al-row-top"
                          onClick={() => toggleOpen(e.id)}
                          aria-expanded={open}
                        >
                          <span className="al-t">{e.t}</span>
                          {_avA(e.actor, 22)}
                          <div className="al-mid">
                            <div className="al-title">
                              {e.title}
                              <span className={"al-tag k-" + e.kind}>{cat.label}</span>
                              {e.signed && (
                                <span className="al-signed" title="Signed by room key">
                                  <IA name="lock" size={9}/>
                                  <span>{e.id.replace(/^ev_/, "").slice(0, 8)}</span>
                                </span>
                              )}
                            </div>
                            <div className="al-sum">{e.summary}</div>
                          </div>
                          <span className={"al-chev" + (open ? " open" : "")} aria-hidden="true">
                            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M3 4 5 6l2-2"/>
                            </svg>
                          </span>
                        </button>
                        {open && (
                          <div className="al-row-detail">
                            {Object.entries(e.meta || {}).map(([k, v]) => v ? (
                              <div className="al-meta-row" key={k}>
                                <span className="al-meta-k">{k}</span>
                                <span className="al-meta-v">{String(v)}</span>
                              </div>
                            ) : null)}
                            <div className="al-meta-row">
                              <span className="al-meta-k">event id</span>
                              <span className="al-meta-v mono">{e.id}</span>
                            </div>
                            <div className="al-row-actions">
                              <button className="btn ghost sm">
                                <IA name="search" size={11}/> Jump to message
                              </button>
                              <button className="btn ghost sm">
                                <IA name="shield" size={11}/> Verify signature
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="m-foot">
          <div className="al-foot-note">
            <IA name="lock" size={11}/>
            <span>Log is append-only, hash-chained, and signed by the room key. Stays on this device.</span>
          </div>
          <span className="grow"/>
          <button className="btn">
            <IA name="archive" size={12}/> Export
          </button>
          <button className="btn primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
};

Object.assign(window, { AuditLogModal });
