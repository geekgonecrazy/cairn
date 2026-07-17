/* Approval-details modal + Call inlay */
const { Icon: I3, AgentTag: AT3, CAIRN: C3 } = window;
const P3 = C3.PEOPLE;

/* ============ Approval details modal ============ */
const ApprovalDetailsModal = ({ inlay, fromId, onClose, onResolve }) => {
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /* parse capability `valve.actuate(bed_3)` into pieces for visual emphasis */
  const cap = inlay.capability;
  const m = cap.match(/^([\w.]+)\((.*)\)$/);
  const verb = m ? m[1] : cap;
  const arg  = m ? m[2] : null;

  const isPending = inlay.state === "pending";

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal detail" onClick={(e) => e.stopPropagation()}>

        <div className="m-head">
          <div className="lockup">
            <div className="icon-wrap"><I3 name="shield" size={18}/></div>
            <div>
              <h2>Capability approval</h2>
              <div className="sub">
                Requested by <AT3 id={fromId} showOp={false}/>
                <span className="dot"/>
                <span>Room <span style={{ color: "var(--text-2)" }}>#ops</span></span>
                <span className="dot"/>
                <span>Broadcast across all transports</span>
              </div>
            </div>
          </div>
          <button className="x" onClick={onClose}><I3 name="x" size={14}/></button>
        </div>

        <div className="m-body">

          {/* What's being asked */}
          <div className="detail-section">
            <div className="label">Capability requested</div>
            <div className="cap-target">
              <span className="verb">{verb}</span>
              {arg && <span style={{ color: "var(--text-3)" }}>(</span>}
              {arg && <span className="arg">{arg}</span>}
              {arg && <span style={{ color: "var(--text-3)" }}>)</span>}
              <span className="scope-tag">real-world</span>
            </div>
            <div className="cap-explain">
              Opens the irrigation valve at <b>bed 3</b> for one short cycle.
              This is a physical actuator; once granted, the agent can run it
              within the scope below without asking again.
            </div>
          </div>

          {/* Scope breakdown */}
          <div className="detail-section">
            <div className="label">Scope &amp; limits</div>
            <div className="scope-grid">
              <div className="k">Target</div>
              <div className="v"><code>valve.bed_3</code> only — other actuators are <b>not</b> authorized.</div>

              <div className="k">Duration</div>
              <div className="v">1 hour from grant · auto-revoked at <code>15:02</code> regardless of use.</div>

              <div className="k">Rate</div>
              <div className="v">Up to <b>1 actuation</b> in this window.</div>

              <div className="k">Operator</div>
              <div className="v">Aaron · this household — accountable for any action taken.</div>

              <div className="k">Reversible?</div>
              <div className="v" style={{ color: "var(--pos)" }}>Yes — flow can be stopped from the panel at any time.</div>
            </div>
          </div>

          {/* What the agent will do */}
          <div className="detail-section">
            <div className="label">If approved, the agent will</div>
            <ol className="plan-list">
              <li><span className="n">1</span><span>Acquire a single-use grant for <code style={{ fontFamily: "var(--font-mono)" }}>valve.actuate(bed_3)</code>.</span></li>
              <li><span className="n">2</span><span>Open the bed-3 valve and run a <b>12-minute</b> light cycle.</span></li>
              <li><span className="n">3</span><span>Close the valve and verify flow returned to zero.</span></li>
              <li><span className="n">4</span><span>Post a <i>task-complete</i> card to this room with the actual flow reading.</span></li>
            </ol>
          </div>

          {/* Why now (provenance) */}
          <div className="detail-section">
            <div className="label">Why this is being asked</div>
            <div className="provenance">
              <div className="row">
                <span className="ico"><I3 name="leaf" size={14}/></span>
                <span>Bed-3 soil moisture dropped to <b>12%</b> — below the 15% threshold the agent watches.</span>
                <span className="meta">13:58</span>
              </div>
              <div className="row">
                <span className="ico"><I3 name="bolt" size={14}/></span>
                <span>Agent decided this is best handled with a short irrigation cycle.</span>
                <span className="meta">14:01</span>
              </div>
              <div className="row">
                <span className="ico"><I3 name="shield" size={14}/></span>
                <span>Actuation requires operator approval — request posted to <code style={{ fontFamily: "var(--font-mono)" }}>#ops</code>.</span>
                <span className="meta">14:02</span>
              </div>
            </div>
          </div>

          {/* After-approval mechanics */}
          <div className="detail-section">
            <div className="label">After approval</div>
            <div className="post-actions">
              <div className="info-tile">
                <div className="t"><I3 name="logs" size={12}/> Audit log</div>
                <div className="d">Every grant and use is recorded under <code style={{ fontFamily: "var(--font-mono)" }}>household / capabilities</code>.</div>
              </div>
              <div className="info-tile">
                <div className="t"><I3 name="x" size={12}/> Revoke any time</div>
                <div className="d">Stop the in-flight action from the Garden panel, or revoke the capability from Settings → Capabilities.</div>
              </div>
              <div className="info-tile">
                <div className="t"><I3 name="clock" size={12}/> Auto-revoke</div>
                <div className="d">The grant expires at <code style={{ fontFamily: "var(--font-mono)" }}>15:02</code> even if unused.</div>
              </div>
            </div>
          </div>

        </div>

        <div className="m-foot">
          {isPending && (
            <span className="timer">
              <I3 name="clock" size={11}/>
              expires {inlay.expiresAt}
            </span>
          )}
          <span className="grow"/>
          {isPending ? (
            <>
              <button className="btn danger" onClick={() => { onResolve("denied"); onClose(); }}>Deny</button>
              <button className="btn primary" onClick={() => { onResolve("approved"); onClose(); }}>
                <I3 name="check" size={12}/> Approve
              </button>
            </>
          ) : (
            <button className="btn" onClick={onClose}>Close</button>
          )}
        </div>
      </div>
    </div>
  );
};

/* ============ Call inlay ============
   States: ringing | active | ended | missed
   Participants carry per-leg conn: self | ringing | joined | declined
*/
const formatDuration = (sec) => {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

const CallTile = ({ pid, conn, muted, talking }) => {
  const p = P3[pid];
  if (!p) return null;
  const stateLabel = {
    self:     "you",
    joined:   "joined",
    ringing:  "ringing",
    declined: "declined",
  }[conn];

  return (
    <div className="call-tile" data-conn={conn}>
      <div className="row1">
        {p.kind === "agent"
          ? <div className="av agent">{p.short}</div>
          : <div className="av" style={{ background: p.color }}>{p.initials}</div>}
        <span className="nm">
          {p.name}
          {p.kind === "agent" && <span className="agt-mini">AGT</span>}
        </span>
      </div>
      <div className="row2">
        <span className="state">
          <span className="pip"/>
          {stateLabel}
        </span>
        <span className="indicators">
          {conn === "joined" && (
            muted ? (
              <span className="ind muted" title="muted">
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                  <rect x="6.5" y="3" width="3" height="6" rx="1.5"/>
                  <path d="M4 8a4 4 0 0 0 8 0"/>
                  <path d="M3 3l10 10"/>
                </svg>
              </span>
            ) : (
              talking ? <span className="level"><span/><span/><span/><span/></span> : <span className="ind" title="mic on">
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                  <rect x="6.5" y="3" width="3" height="6" rx="1.5"/>
                  <path d="M4 8a4 4 0 0 0 8 0"/>
                  <path d="M8 12v2"/>
                </svg>
              </span>
            )
          )}
          {conn === "self" && (
            muted ? (
              <span className="ind muted" title="you are muted">
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                  <rect x="6.5" y="3" width="3" height="6" rx="1.5"/>
                  <path d="M4 8a4 4 0 0 0 8 0"/>
                  <path d="M3 3l10 10"/>
                </svg>
              </span>
            ) : (talking
              ? <span className="level"><span/><span/><span/><span/></span>
              : <span className="ind" title="you, mic on">
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                    <rect x="6.5" y="3" width="3" height="6" rx="1.5"/>
                    <path d="M4 8a4 4 0 0 0 8 0"/>
                    <path d="M8 12v2"/>
                  </svg>
                </span>
            )
          )}
        </span>
      </div>
    </div>
  );
};

const CallInlay = ({ inlay, msgId, onUpdate, onEnd, onJoin, onViewDetails }) => {
  const { state, startedAt, startedBy, participants } = inlay;

  /* ticking duration for active calls */
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (state !== "active") return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [state]);

  const elapsed = (() => {
    if (state === "ringing")            return "ringing…";
    if (state === "active" && startedAt) return formatDuration(Math.max(0, Math.floor((now - startedAt) / 1000)));
    if (state === "ended"  && inlay.duration != null) return formatDuration(inlay.duration);
    if (state === "missed")             return "missed";
    return "—";
  })();

  const titleByState = {
    ringing: "Calling…",
    active:  "Voice call",
    ended:   "Call ended",
    missed:  "Missed call",
  };

  const joinedCount   = participants.filter(p => p.conn === "joined" || p.conn === "self").length;
  const ringingCount  = participants.filter(p => p.conn === "ringing").length;
  const declinedCount = participants.filter(p => p.conn === "declined").length;

  const youAreIn = participants.some(p => p.conn === "self");
  const me = participants.find(p => p.conn === "self");

  return (
    <div className="call-inlay" data-state={state}>
      <div className="ci-head">
        <div className="icon">
          <I3 name="phone" size={15}/>
        </div>
        <div className="title-block">
          <div className="title">
            {titleByState[state]}
            <span style={{ fontWeight: 400, color: "var(--text-3)", fontSize: 12 }}>
              · started by {P3[startedBy]?.name ?? "—"}
            </span>
          </div>
          <div className="sub">
            <span>{joinedCount} on the line</span>
            {ringingCount > 0  && <><span className="dot"/><span style={{ color: "var(--busy)" }}>{ringingCount} ringing</span></>}
            {declinedCount > 0 && <><span className="dot"/><span>{declinedCount} declined</span></>}
            {state === "ended" && <><span className="dot"/><span>ended at {inlay.endedAtLabel}</span></>}
          </div>
        </div>
        <div className="duration">{elapsed}</div>
      </div>

      {(state === "ringing" || state === "active") && (
        <div className="always-broadcast">
          <span className="lock">LOCKED</span>
          <span className="why">
            Calls broadcast across every available transport for urgency — this cannot be turned off.
          </span>
        </div>
      )}

      <div className="participants">
        {participants.map(p => (
          <CallTile key={p.id} pid={p.id} conn={p.conn} muted={p.muted} talking={p.talking}/>
        ))}
      </div>

      {(state === "ringing" || state === "active") && (
        <div className="ci-actions">
          {youAreIn && (
            <button
              className="ico-toggle"
              aria-pressed={me?.muted ? "true" : "false"}
              title={me?.muted ? "Unmute" : "Mute"}
              onClick={() => onUpdate(msgId, { toggleMute: true })}
            >
              {me?.muted ? (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                  <rect x="6.5" y="3" width="3" height="6" rx="1.5"/>
                  <path d="M4 8a4 4 0 0 0 8 0"/>
                  <path d="M3 3l10 10"/>
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                  <rect x="6.5" y="3" width="3" height="6" rx="1.5"/>
                  <path d="M4 8a4 4 0 0 0 8 0"/>
                  <path d="M8 12v2"/>
                </svg>
              )}
            </button>
          )}
          <button
            className="ico-toggle"
            title="Settings"
            onClick={() => onUpdate(msgId, { toggleSpeaker: true })}
          >
            <I3 name="settings" size={14}/>
          </button>
          <button className="btn ghost sm" onClick={onViewDetails}>
            <I3 name="logs" size={12}/> View detail
          </button>
          <div className="grow"/>
          {!youAreIn && state === "ringing" && (
            <button className="join" onClick={() => onJoin(msgId)}>
              <I3 name="phone" size={12}/> Join
            </button>
          )}
          <button className="hang" onClick={() => onEnd(msgId)}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M2.5 9.5a8 8 0 0 1 11 0l-1.4 2.1a1 1 0 0 1-1.3.3l-1.6-.9-.4-1.6a8 8 0 0 0-1.6 0l-.4 1.6-1.6.9a1 1 0 0 1-1.3-.3L2.5 9.5Z"/>
            </svg>
            {youAreIn ? "Hang up" : "Decline"}
          </button>
        </div>
      )}

      {state === "missed" && (
        <div className="ci-actions">
          <button className="btn ghost sm" onClick={onViewDetails}>
            <I3 name="logs" size={12}/> View detail
          </button>
          <div className="grow"/>
          <button className="btn"><I3 name="phone" size={12}/> Call back</button>
        </div>
      )}

      {state === "ended" && (
        <div className="ci-actions">
          <button className="btn ghost sm" onClick={onViewDetails}>
            <I3 name="logs" size={12}/> View detail
          </button>
          <div className="grow"/>
          <button className="btn"><I3 name="phone" size={12}/> Call again</button>
        </div>
      )}
    </div>
  );
};

Object.assign(window, { ApprovalDetailsModal, CallInlay });

/* ============================================================== */
/* ============ Global call bar (cross-room) ============ */
/* ============================================================== */
const GlobalCallBar = ({ call, isHere, onJump, onToggleMute, onEnd }) => {
  const { inlay, room } = call;
  const me = inlay.participants.find(p => p.conn === "self");

  /* ticking duration */
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (inlay.state !== "active") return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [inlay.state]);

  const elapsed = (() => {
    if (inlay.state === "ringing") return "ringing…";
    if (inlay.state === "active" && inlay.startedAt) {
      const sec = Math.max(0, Math.floor((now - inlay.startedAt) / 1000));
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }
    return "—";
  })();

  const onLine = inlay.participants.filter(p => p.conn === "joined" || p.conn === "self");
  const stack = onLine.slice(0, 4);

  return (
    <div className="global-call-bar" data-state={inlay.state}>
      <div className="gcb-icon">
        <I3 name="phone" size={14}/>
      </div>
      <div className="gcb-body">
        <div className="gcb-title">
          <span>{inlay.state === "ringing" ? "Calling…" : "On a call"}</span>
          <span className="gcb-state">{inlay.state}</span>
        </div>
        <div className="gcb-sub">
          <span>{onLine.length} on the line</span>
          <span className="dot"/>
          {isHere ? (
            <span>in <b>{room.glyph}{room.name}</b> · this room</span>
          ) : (
            <>
              <span>in </span>
              <button className="room-link" onClick={onJump}>{room.glyph}{room.name}</button>
              <span className="dot"/>
              <button className="room-link" onClick={onJump}>jump to room ↗</button>
            </>
          )}
        </div>
      </div>
      <div className="gcb-stack">
        {stack.map(p => {
          const person = P3[p.id];
          if (!person) return null;
          if (person.kind === "agent") {
            return <span key={p.id} className="gcb-av agent" title={person.name}>{person.short}</span>;
          }
          return <span key={p.id} className="gcb-av" style={{ background: person.color }} title={person.name}>{person.initials}</span>;
        })}
      </div>
      <div className="gcb-duration">{elapsed}</div>
      <div className="gcb-actions">
        {me && (
          <button
            className={"gcb-btn" + (me.muted ? " muted" : "")}
            onClick={onToggleMute}
            title={me.muted ? "Unmute" : "Mute"}
          >
            {me.muted ? (
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
                <rect x="6.5" y="3" width="3" height="6" rx="1.5"/>
                <path d="M4 8a4 4 0 0 0 8 0"/>
                <path d="M3 3l10 10"/>
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
                <rect x="6.5" y="3" width="3" height="6" rx="1.5"/>
                <path d="M4 8a4 4 0 0 0 8 0"/>
                <path d="M8 12v2"/>
              </svg>
            )}
            <span>{me.muted ? "Unmute" : "Mute"}</span>
          </button>
        )}
        <button className="gcb-btn hang" onClick={onEnd} title="Hang up">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M2.5 9.5a8 8 0 0 1 11 0l-1.4 2.1a1 1 0 0 1-1.3.3l-1.6-.9-.4-1.6a8 8 0 0 0-1.6 0l-.4 1.6-1.6.9a1 1 0 0 1-1.3-.3L2.5 9.5Z"/>
          </svg>
          <span>End</span>
        </button>
      </div>
    </div>
  );
};

Object.assign(window, { GlobalCallBar });
