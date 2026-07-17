/* Detail modals: Poll, Task-complete, Call */
const { Icon: ID, AgentTag: ATD, CAIRN: CD } = window;
const PD = CD.PEOPLE;

const _fmtDur = (sec) => {
  if (sec == null) return "—";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m === 0) return `${s}s`;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
};

const _avatar = (id, size = 22) => {
  const p = PD[id];
  if (!p) return null;
  if (p.kind === "agent") {
    return <div className="dm-av agent" style={{ width: size, height: size }}>{p.short}</div>;
  }
  return (
    <div className="dm-av" style={{ width: size, height: size, background: p.color }}>{p.initials}</div>
  );
};

const _name = (id) => PD[id]?.name ?? "—";

const _useEsc = (onClose) => {
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
};

/* ============================================================== */
/* ============ Poll details modal ============ */
/* ============================================================== */
const PollDetailsModal = ({ inlay, fromId, onClose, onVote }) => {
  _useEsc(onClose);

  const total = inlay.options.reduce((s, o) => s + o.votes, 0);
  const createdBy = inlay.createdBy ?? fromId;
  const leader = [...inlay.options].sort((a, b) => b.votes - a.votes)[0];

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal detail" onClick={(e) => e.stopPropagation()}>

        <div className="m-head">
          <div className="lockup">
            <div className="icon-wrap poll"><ID name="users" size={18}/></div>
            <div>
              <h2>{inlay.question}</h2>
              <div className="sub">
                Poll by <ATD id={createdBy} showOp={false}/>
                <span className="dot"/>
                <span>{total} vote{total !== 1 ? "s" : ""}</span>
                {inlay.closesAt && <><span className="dot"/><span>closes {inlay.closesAt}</span></>}
              </div>
            </div>
          </div>
          <button className="x" onClick={onClose}><ID name="x" size={14}/></button>
        </div>

        <div className="m-body">

          {/* Leader summary */}
          <div className="detail-section">
            <div className="label">Current standing</div>
            <div className="poll-leader">
              <div className="big">
                <div className="lab">{leader?.label}</div>
                <div className="meta">
                  {leader?.votes} of {total} votes
                  {total > 0 && <> · {Math.round((leader.votes / total) * 100)}%</>}
                </div>
              </div>
              <div className="poll-leader-bar" style={{
                width: total ? `${Math.round((leader.votes / total) * 100)}%` : "0%"
              }}/>
            </div>
          </div>

          {/* Option breakdown with voters */}
          <div className="detail-section">
            <div className="label">Breakdown</div>
            <div className="poll-breakdown">
              {inlay.options.map(opt => {
                const pct = total ? Math.round((opt.votes / total) * 100) : 0;
                const voters = opt.voters ?? [];
                const sel = inlay.myVote === opt.id;
                return (
                  <div key={opt.id} className="poll-bd" data-selected={sel}>
                    <div className="poll-bd-row">
                      <div className="lab">{opt.label}</div>
                      <div className="grow"/>
                      <div className="ct">{opt.votes}</div>
                      <div className="pct">{pct}%</div>
                    </div>
                    <div className="poll-bd-bar"><span style={{ width: `${pct}%` }}/></div>
                    <div className="poll-bd-voters">
                      {voters.length === 0 && <span className="empty">— no votes yet</span>}
                      {voters.map(v => (
                        <span className="chip" key={v}>
                          {_avatar(v, 18)}
                          <span>{_name(v)}</span>
                        </span>
                      ))}
                      {!sel ? (
                        <button className="btn ghost sm vote-here" onClick={() => onVote(opt.id)}>
                          {inlay.myVote ? "Switch vote" : "Vote"}
                        </button>
                      ) : (
                        <span className="you-voted"><ID name="check" size={11}/> your vote</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Activity */}
          {inlay.activity && (
            <div className="detail-section">
              <div className="label">Activity</div>
              <div className="provenance">
                {inlay.activity.map((a, i) => (
                  <div className="row" key={i}>
                    <span className="ico">{_avatar(a.who, 18)}</span>
                    <span><b>{_name(a.who)}</b> {a.what}.</span>
                    <span className="meta">{a.t}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Mechanics */}
          <div className="detail-section">
            <div className="label">How this poll works</div>
            <div className="post-actions">
              <div className="info-tile">
                <div className="t"><ID name="users" size={12}/> Visible to room</div>
                <div className="d">All 4 members of <code>#family</code> can see the question and votes.</div>
              </div>
              <div className="info-tile">
                <div className="t"><ID name="clock" size={12}/> Auto-closes</div>
                <div className="d">Stops accepting votes at <code>{inlay.closesAt ?? "—"}</code>. Result stays visible.</div>
              </div>
              <div className="info-tile">
                <div className="t"><ID name="shield" size={12}/> No auto-action</div>
                <div className="d">Polls don't trigger capabilities. The winner is informational only.</div>
              </div>
            </div>
          </div>

        </div>

        <div className="m-foot">
          <span className="grow"/>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
};

/* ============================================================== */
/* ============ Task-complete details modal ============ */
/* ============================================================== */
const TaskDetailsModal = ({ inlay, fromId, onClose }) => {
  _useEsc(onClose);
  const d = inlay.detail ?? {};

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal detail" onClick={(e) => e.stopPropagation()}>

        <div className="m-head">
          <div className="lockup">
            <div className="icon-wrap task"><ID name="check" size={18}/></div>
            <div>
              <h2>{inlay.title}</h2>
              <div className="sub">
                Run by <ATD id={fromId} showOp={false}/>
                {d.requestedBy && <><span className="dot"/><span>at request of {_name(d.requestedBy)}</span></>}
                <span className="dot"/>
                <span>{inlay.sub}</span>
              </div>
            </div>
          </div>
          <button className="x" onClick={onClose}><ID name="x" size={14}/></button>
        </div>

        <div className="m-body">

          {/* Run summary */}
          <div className="detail-section">
            <div className="label">Run summary</div>
            <div className="scope-grid">
              <div className="k">Started</div>
              <div className="v"><code>{d.startedAt ?? "—"}</code></div>

              <div className="k">Ended</div>
              <div className="v"><code>{d.endedAt ?? "—"}</code></div>

              <div className="k">Duration</div>
              <div className="v">{_fmtDur(d.durationSec)}</div>

              <div className="k">Operator</div>
              <div className="v">{PD[fromId]?.op ?? "—"} · accountable for this run</div>

              <div className="k">Outcome</div>
              <div className="v" style={{ color: "var(--pos)" }}>Completed cleanly · no follow-up required</div>
            </div>
          </div>

          {/* Capabilities used */}
          {d.capabilities?.length > 0 && (
            <div className="detail-section">
              <div className="label">Capabilities used</div>
              <div className="cap-list">
                {d.capabilities.map((c, i) => (
                  <div className="cap-row" key={i}>
                    <span className="cap-name">{c.name}</span>
                    <span className="cap-scope">{c.scope}</span>
                    <span className="cap-tag">one-shot</span>
                  </div>
                ))}
              </div>
              <div className="cap-explain" style={{ marginTop: 10 }}>
                Read-only sensor grants — auto-released when the run ended.
              </div>
            </div>
          )}

          {/* Steps */}
          {d.steps?.length > 0 && (
            <div className="detail-section">
              <div className="label">What the agent did</div>
              <ol className="plan-list">
                {d.steps.map((s, i) => (
                  <li key={i}>
                    <span className="n">{i + 1}</span>
                    <span>
                      {s.label}
                      {s.t && <span className="step-time"> · {s.t}</span>}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {/* Readings / outputs */}
          {d.readings?.length > 0 && (
            <div className="detail-section">
              <div className="label">Readings</div>
              <div className="readings-grid">
                {d.readings.map((r, i) => (
                  <div className="reading" key={i}>
                    <div className="k">{r.k}</div>
                    <div className="v">{r.v}</div>
                    {r.note && <div className="n">{r.note}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Notes */}
          {d.notes && (
            <div className="detail-section">
              <div className="label">Agent notes</div>
              <div className="cap-explain" style={{ marginTop: 0 }}>{d.notes}</div>
            </div>
          )}

        </div>

        <div className="m-foot">
          <button className="btn"><ID name="logs" size={12}/> Audit log</button>
          <button className="btn"><ID name="bolt" size={12}/> Re-run</button>
          <span className="grow"/>
          <button className="btn primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
};

/* ============================================================== */
/* ============ Call details modal ============ */
/* ============================================================== */
const CallDetailsModal = ({ inlay, fromId, onClose }) => {
  _useEsc(onClose);

  const stateLabel = {
    ringing: "Ringing",
    active:  "In progress",
    ended:   "Ended",
    missed:  "Missed",
  }[inlay.state] ?? inlay.state;

  const joined   = inlay.participants.filter(p => p.conn === "joined" || p.conn === "self");
  const ringing  = inlay.participants.filter(p => p.conn === "ringing");
  const declined = inlay.participants.filter(p => p.conn === "declined");

  const startTimeLabel = inlay.startedAt
    ? new Date(inlay.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
    : "—";

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal detail" onClick={(e) => e.stopPropagation()}>

        <div className="m-head">
          <div className="lockup">
            <div className={"icon-wrap call state-" + inlay.state}><ID name="phone" size={18}/></div>
            <div>
              <h2>Voice call · {stateLabel}</h2>
              <div className="sub">
                Started by <ATD id={inlay.startedBy} showOp={false}/>
                <span className="dot"/>
                <span>at {startTimeLabel}</span>
                <span className="dot"/>
                <span>Broadcast across all transports</span>
              </div>
            </div>
          </div>
          <button className="x" onClick={onClose}><ID name="x" size={14}/></button>
        </div>

        <div className="m-body">

          {/* Run summary */}
          <div className="detail-section">
            <div className="label">Call summary</div>
            <div className="scope-grid">
              <div className="k">Started</div>
              <div className="v"><code>{startTimeLabel}</code> by {_name(inlay.startedBy)}</div>

              {inlay.state === "ended" && (
                <>
                  <div className="k">Ended</div>
                  <div className="v"><code>{inlay.endedAtLabel ?? "—"}</code></div>
                </>
              )}

              <div className="k">Duration</div>
              <div className="v">
                {inlay.state === "active" && <span style={{ color: "var(--pos)" }}>in progress</span>}
                {inlay.state === "ringing" && <span style={{ color: "var(--busy)" }}>ringing…</span>}
                {inlay.state === "ended" && _fmtDur(inlay.duration)}
                {inlay.state === "missed" && <span style={{ color: "var(--neg)" }}>missed — no one picked up</span>}
              </div>

              <div className="k">On the line</div>
              <div className="v">
                {joined.length} joined
                {ringing.length  > 0 && <>, {ringing.length} ringing</>}
                {declined.length > 0 && <>, {declined.length} declined</>}
              </div>

              <div className="k">Recording</div>
              <div className="v">Off — Cairn never records voice calls.</div>
            </div>
          </div>

          {/* Participants table */}
          <div className="detail-section">
            <div className="label">Participants</div>
            <div className="participant-table">
              {inlay.participants.map(p => {
                const person = PD[p.id];
                if (!person) return null;
                const stateText = {
                  self:     "you · on the line",
                  joined:   "joined",
                  ringing:  "ringing…",
                  declined: "declined the call",
                }[p.conn];
                const stateClass = {
                  self:     "pos",
                  joined:   "pos",
                  ringing:  "busy",
                  declined: "neg",
                }[p.conn];
                return (
                  <div className="pt-row" key={p.id} data-conn={p.conn}>
                    <div className="pt-who">
                      {_avatar(p.id, 28)}
                      <div className="pt-name">
                        {person.name}
                        {person.kind === "agent" && <span className="agt-mini">AGT</span>}
                        <div className="pt-id">@{p.id.replace(/^[au]_/, "")}</div>
                      </div>
                    </div>
                    <div className={"pt-state " + stateClass}>
                      <span className="pip"/>
                      {stateText}
                    </div>
                    <div className="pt-meta">
                      {(p.conn === "joined" || p.conn === "self") && (
                        p.muted
                          ? <span className="pt-flag mute">muted</span>
                          : (p.talking
                              ? <span className="pt-flag talk">speaking</span>
                              : <span className="pt-flag">mic on</span>)
                      )}
                      {p.conn === "ringing"  && <span className="pt-flag">notifying device</span>}
                      {p.conn === "declined" && <span className="pt-flag">declined at source</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Transports */}
          <div className="detail-section">
            <div className="label">Transports in use</div>
            <div className="transports">
              <div className="t-row">
                <span className="t-name">LAN <code>cairn.local</code></span>
                <span className="t-bar"><span style={{ width: "78%" }}/></span>
                <span className="t-state pos">primary · stable</span>
              </div>
              <div className="t-row">
                <span className="t-name">Mesh <code>br0</code></span>
                <span className="t-bar"><span style={{ width: "42%" }}/></span>
                <span className="t-state">standby · ready</span>
              </div>
              <div className="t-row">
                <span className="t-name">Bluetooth fallback</span>
                <span className="t-bar"><span style={{ width: "18%" }}/></span>
                <span className="t-state">idle</span>
              </div>
            </div>
            <div className="cap-explain" style={{ marginTop: 10 }}>
              Calls always broadcast on every available transport — if one drops, the others carry the audio
              without re-dialing. This cannot be turned off.
            </div>
          </div>

          {/* Activity */}
          <div className="detail-section">
            <div className="label">Activity</div>
            <div className="provenance">
              <div className="row">
                <span className="ico"><ID name="phone" size={14}/></span>
                <span><b>{_name(inlay.startedBy)}</b> started the call.</span>
                <span className="meta">{startTimeLabel}</span>
              </div>
              {joined.filter(p => p.conn === "joined").map(p => (
                <div className="row" key={p.id}>
                  <span className="ico">{_avatar(p.id, 16)}</span>
                  <span><b>{_name(p.id)}</b> joined.</span>
                  <span className="meta">just now</span>
                </div>
              ))}
              {ringing.map(p => (
                <div className="row" key={p.id}>
                  <span className="ico">{_avatar(p.id, 16)}</span>
                  <span><b>{_name(p.id)}</b> is still ringing.</span>
                  <span className="meta">—</span>
                </div>
              ))}
              {declined.map(p => (
                <div className="row" key={p.id}>
                  <span className="ico">{_avatar(p.id, 16)}</span>
                  <span><b>{_name(p.id)}</b> declined the call.</span>
                  <span className="meta">—</span>
                </div>
              ))}
              {inlay.state === "ended" && (
                <div className="row">
                  <span className="ico"><ID name="x" size={14}/></span>
                  <span>Call ended.</span>
                  <span className="meta">{inlay.endedAtLabel}</span>
                </div>
              )}
            </div>
          </div>

        </div>

        <div className="m-foot">
          <span className="grow"/>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
};

Object.assign(window, { PollDetailsModal, TaskDetailsModal, CallDetailsModal });
