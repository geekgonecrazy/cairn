/* Inlays: Poll, AgentPanel, ApprovalPrompt, TaskComplete, AddTaskModal */
const { Icon: I2, AgentTag: AT2, CAIRN: C2 } = window;
const P2 = C2.PEOPLE;

/* ============ Poll (inline) ============ */
const PollInlay = ({ inlay, onVote, onViewDetails }) => {
  const total = inlay.options.reduce((s, o) => s + o.votes, 0) || 1;
  const closesIn = inlay.closesAt ? `closes ${inlay.closesAt}` : null;

  return (
    <div className="inlay" role="group" aria-label={`Poll: ${inlay.question}`}>
      <div className="head">
        <div className="icon"><I2 name="users" size={14}/></div>
        <div className="title-block">
          <div className="title">{inlay.question}</div>
          <div className="sub">
            {inlay.totalVotes ?? total} vote{(inlay.totalVotes ?? total) !== 1 ? "s" : ""}
            {closesIn && <> · {closesIn}</>}
            {inlay.myVote ? <> · <span style={{ color: "var(--accent)" }}>you voted</span></> : <> · tap an option to vote</>}
          </div>
        </div>
      </div>
      <div>
        {inlay.options.map(opt => {
          const pct = Math.round((opt.votes / total) * 100);
          const sel = inlay.myVote === opt.id;
          return (
            <div
              key={opt.id}
              className="poll-opt"
              data-selected={sel}
              onClick={() => onVote(opt.id)}
            >
              <div className="bar-fill" style={{ width: `${pct}%` }}/>
              <div className="radio"/>
              <div className="label">{opt.label}</div>
              <div className="pct">{pct}%</div>
            </div>
          );
        })}
      </div>
      <div className="actions" style={{ marginTop: 6 }}>
        <span style={{ flex: 1 }}/>
        <button className="btn ghost sm" onClick={onViewDetails}>
          <I2 name="logs" size={12}/> View detail
        </button>
      </div>
    </div>
  );
};

/* ============ Approval (inline, capability-bound) ============ */
const ApprovalInlay = ({ inlay, onResolve, fromId, onViewDetails }) => {
  return (
    <div className="inlay approval" data-state={inlay.state}>
      <div className="head">
        <div className="icon"><I2 name="shield" size={14}/></div>
        <div className="title-block">
          <div className="title">
            <AT2 id={fromId} showOp={false}/> requests approval
          </div>
          <div className="sub">
            {inlay.state === "pending"  && <>Requested {inlay.requestedAt} · expires {inlay.expiresAt}</>}
            {inlay.state === "approved" && <span style={{ color: "var(--pos)" }}>Approved · agent continued</span>}
            {inlay.state === "denied"   && <span style={{ color: "var(--neg)" }}>Denied · agent blocked</span>}
            {inlay.state === "expired"  && <span style={{ color: "var(--text-3)" }}>Expired · agent reported blocked</span>}
          </div>
        </div>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span className="status-chip" data-polarity={
            inlay.state === "approved" ? "positive" :
            inlay.state === "denied"   ? "negative" :
            inlay.state === "pending"  ? "busy"     : "neutral"
          }>
            <span className="swatch"/>
            {inlay.state}
          </span>
        </div>
      </div>

      <div className="capability-row">
        <div className="k">Capability</div>
        <div className="v">{inlay.capability}</div>
        <div className="k">Scope</div>
        <div className="v scope">{inlay.scope}</div>
      </div>

      {inlay.state === "pending" && (
        <div className="disclosure">
          <I2 name="warning" size={14}/>
          <span>Approving authorizes a real-world action on your behalf.</span>
        </div>
      )}

      {inlay.state === "pending" && (
        <div className="actions" style={{ marginTop: 12 }}>
          <button className="btn primary" onClick={() => onResolve("approved")}>
            <I2 name="check" size={12}/> Approve
          </button>
          <button className="btn danger" onClick={() => onResolve("denied")}>Deny</button>
          <span style={{ flex: 1 }}/>
          <button className="btn ghost sm" onClick={onViewDetails}>View details</button>
        </div>
      )}
      {inlay.state !== "pending" && (
        <div className="actions" style={{ marginTop: 6 }}>
          <span style={{ flex: 1 }}/>
          <button className="btn ghost sm" onClick={onViewDetails}>
            <I2 name="logs" size={12}/> View details
          </button>
        </div>
      )}
    </div>
  );
};

/* ============ Suggestion list (e.g. movie picks, book picks) ============ */
const SuggestionListInlay = ({ inlay, fromId, onAddToPoll, onViewDetails }) => {
  const added = inlay.added || [];
  const fmtRun = (m) => `${m} min`;
  return (
    <div className="inlay sl-inlay" role="group" aria-label={inlay.title}>
      <div className="head">
        <div className="icon"><I2 name="spark" size={14}/></div>
        <div className="title-block">
          <div className="title">{inlay.title}</div>
          <div className="sub">
            <AT2 id={fromId} showOp={false}/>{inlay.sub ? <> · {inlay.sub}</> : null}
          </div>
        </div>
      </div>
      <div className="sl-list">
        {inlay.items.map(item => {
          const isAdded = added.includes(item.id);
          return (
            <div key={item.id} className={"sl-card" + (isAdded ? " added" : "")}>
              <div
                className="sl-poster"
                style={{ background: `linear-gradient(135deg, ${item.tone}, ${item.tone2})` }}
                aria-hidden="true"
              >
                <span className="sl-poster-title">{item.title}</span>
              </div>
              <div className="sl-body">
                <div className="sl-title">{item.title}</div>
                <div className="sl-meta">
                  <span>{item.year}</span>
                  <span className="dot"/>
                  <span>{fmtRun(item.runtime)}</span>
                  {item.tag && <><span className="dot"/><span>{item.tag}</span></>}
                </div>
                <div className="sl-why">{item.why}</div>
              </div>
              <div className="sl-card-action">
                {isAdded ? (
                  <span className="sl-added-chip">
                    <I2 name="check" size={11}/> added
                  </span>
                ) : inlay.targetPollId ? (
                  <button className="btn sm primary" onClick={() => onAddToPoll(item.id)}>
                    <I2 name="plus" size={11}/> Add to poll
                  </button>
                ) : (
                  <button className="btn sm" onClick={() => onAddToPoll(item.id)}>
                    <I2 name="plus" size={11}/> Pick
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="sl-foot">
        <span>Picks based on the room's recent poll · won't auto-vote.</span>
        <span className="grow"/>
        <button className="btn sm ghost" onClick={onViewDetails}>
          <I2 name="logs" size={12}/> Why these
        </button>
      </div>
    </div>
  );
};

/* ============ Task-complete (inline notification card) ============ */
const TaskCompleteCard = ({ inlay, fromId, onViewDetails }) => (
  <div className="inlay task-card">
    <div className="head">
      <div className="icon"><I2 name="check" size={14}/></div>
      <div className="title-block">
        <div className="title">{inlay.title}</div>
        <div className="sub">
          <AT2 id={fromId} showOp={false}/> · {inlay.sub}
        </div>
      </div>
      <button className="btn sm ghost" onClick={onViewDetails}>
        <I2 name="logs" size={12}/> View detail
      </button>
    </div>
  </div>
);

/* ============ Renderer dispatch (inline) ============ */
const InlayRenderer = ({ inlay, msgId, fromId, onPollVote, onApproval, onViewDetails, onCallUpdate, onCallEnd, onCallJoin, onSuggestionAdd, onVideoUpdate, onVideoExpand }) => {
  switch (inlay.kind) {
    case "poll":      return <PollInlay inlay={inlay} onVote={(opt) => onPollVote(msgId, opt)} onViewDetails={() => onViewDetails(msgId)} />;
    case "approval":  return <ApprovalInlay inlay={inlay} fromId={fromId} onResolve={(s) => onApproval(msgId, s)} onViewDetails={() => onViewDetails(msgId)} />;
    case "task-card": return <TaskCompleteCard inlay={inlay} fromId={fromId} onViewDetails={() => onViewDetails(msgId)}/>;
    case "call":      return <window.CallInlay inlay={inlay} msgId={msgId} onUpdate={onCallUpdate} onEnd={onCallEnd} onJoin={onCallJoin} onViewDetails={() => onViewDetails(msgId)}/>;
    case "suggestion-list": return <SuggestionListInlay inlay={inlay} fromId={fromId} onAddToPoll={(sid) => onSuggestionAdd?.(msgId, sid)} onViewDetails={() => onViewDetails?.(msgId)}/>;
    case "video":     return <window.VideoInlay inlay={inlay} msgId={msgId} fromId={fromId} onUpdate={onVideoUpdate} onExpand={() => onVideoExpand?.(msgId)} onViewDetails={() => onViewDetails(msgId)}/>;
    default:          return <div className="inlay"><div className="head"><div className="title-block"><div className="title">{inlay.kind}</div><div className="sub">inlay fallback</div></div></div></div>;
  }
};

/* ============ Agent room panel (persistent) ============ */
const AgentPanel = ({ agentId, tasks, onAddTask, onConfigure, onLogs, collapsed, onToggleCollapse }) => {
  const a = P2[agentId];
  const running = tasks.filter(t => t.state === "running");
  const queued  = tasks.filter(t => t.state === "queued");
  const done    = tasks.filter(t => t.state === "done");

  return (
    <div className="panel-card" data-collapsed={collapsed ? "true" : "false"}>
      <button className="panel-head as-button" onClick={onToggleCollapse}>
        <div className="ico">{a.short}</div>
        <div className="title-block">
          <div className="title">
            <AT2 id={agentId} showOp={false}/>
          </div>
          <div className="sub">
            <span className="status-chip" data-polarity="busy">
              <span className="swatch"/> running
            </span>
            <span>{running.length} live · {queued.length} queued</span>
          </div>
        </div>
        <span className="panel-chevron" aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 4.5 6 7.5l3-3"/>
          </svg>
        </span>
      </button>

      {!collapsed && (
        <>
          <div className="panel-stats">
            <div className="panel-stat">
              <div className="k">Running</div>
              <div className="v">{running.length}<small>tasks</small></div>
            </div>
            <div className="panel-stat">
              <div className="k">Queued</div>
              <div className="v">{queued.length}<small>tasks</small></div>
            </div>
            <div className="panel-stat">
              <div className="k">Done today</div>
              <div className="v">{done.length}<small>tasks</small></div>
            </div>
          </div>

          <div className="panel-tasks">
            {running.length > 0 && (
              <>
                <div className="panel-section-label"><span>In progress</span><span style={{ color: "var(--text-4)", fontFamily: "var(--font-mono)" }}>{running.length}</span></div>
                {running.map(t => (
                  <div key={t.id} className="task-row running">
                    <span className="glyph running">●</span>
                    <div className="t">
                      <div className="name">{t.title}</div>
                      <div className="bar"><div className="bar-fill" style={{ width: `${Math.round(t.progress * 100)}%` }}/></div>
                    </div>
                    <span className="pct">{Math.round(t.progress * 100)}%</span>
                  </div>
                ))}
              </>
            )}
            {queued.length > 0 && (
              <>
                <div className="panel-section-label"><span>Queued</span><span style={{ color: "var(--text-4)", fontFamily: "var(--font-mono)" }}>{queued.length}</span></div>
                {queued.map(t => (
                  <div key={t.id} className="task-row queued">
                    <span className="glyph">◦</span>
                    <div className="t">
                      <div className="name">{t.title}</div>
                    </div>
                    <span className="queued-label">queued</span>
                  </div>
                ))}
              </>
            )}
            {done.length > 0 && (
              <>
                <div className="panel-section-label"><span>Done today</span><span style={{ color: "var(--text-4)", fontFamily: "var(--font-mono)" }}>{done.length}</span></div>
                {done.slice(-3).map(t => (
                  <div key={t.id} className="task-row done">
                    <span className="glyph done">✓</span>
                    <div className="t">
                      <div className="name">{t.title}</div>
                    </div>
                    <span className="pct">100%</span>
                  </div>
                ))}
              </>
            )}
          </div>

          <div className="panel-foot">
            <button className="btn primary sm" onClick={onAddTask}>
              <I2 name="plus" size={12}/> Add task
            </button>
            <button className="btn sm" onClick={onConfigure}><I2 name="sliders" size={12}/> Configure</button>
            <button className="btn ghost sm" onClick={onLogs}><I2 name="logs" size={12}/> Logs</button>
          </div>
        </>
      )}
    </div>
  );
};

/* ============ Capabilities card (per-room active grants) ============ */
const CapabilitiesCard = ({ collapsed, onToggleCollapse, onOpenAudit }) => {
  /* Sample active capability state — a real implementation would derive these from approval history */
  const grants = [
    { name: "sensor.read(soil_moisture)", scope: "all beds",    expires: "while open",  state: "active",  short: "passive" },
    { name: "sensor.read(soil_temp)",     scope: "all beds",    expires: "while open",  state: "active",  short: "passive" },
    { name: "valve.actuate(bed_3)",       scope: "1 hour",      expires: "15:02",       state: "pending", short: "awaiting Aaron" },
  ];
  const active  = grants.filter(g => g.state === "active");
  const pending = grants.filter(g => g.state === "pending");

  return (
    <div className="panel-card" data-collapsed={collapsed ? "true" : "false"} style={{ marginTop: 12 }}>
      <button className="panel-head as-button" onClick={onToggleCollapse}>
        <div className="ico"><I2 name="shield" size={14}/></div>
        <div className="title-block">
          <div className="title">Capabilities</div>
          <div className="sub">
            <span>{active.length} active</span>
            {pending.length > 0 && <><span style={{ color: "var(--text-4)" }}>·</span><span style={{ color: "var(--warn)" }}>{pending.length} pending</span></>}
            <span style={{ color: "var(--text-4)" }}>·</span>
            <span>this room only</span>
          </div>
        </div>
        <span className="panel-chevron" aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 4.5 6 7.5l3-3"/>
          </svg>
        </span>
      </button>

      {!collapsed && (
        <div className="cap-side-list">
          {grants.map((g, i) => (
            <div key={i} className={"cap-side-row state-" + g.state}>
              <div className="cap-side-top">
                <span className="cap-side-name">{g.name}</span>
                <span className={"cap-side-tag " + g.state}>{g.state}</span>
              </div>
              <div className="cap-side-meta">
                <span>{g.scope}</span>
                <span className="dot"/>
                <span>{g.short}</span>
              </div>
            </div>
          ))}
          <button className="btn ghost sm" style={{ alignSelf: "flex-start" }} onClick={onOpenAudit}>
            <I2 name="logs" size={12}/> Open audit log
          </button>
        </div>
      )}
    </div>
  );
};

/* ============ Members card ============ */
const MembersCard = ({ memberIds }) => (
  <div className="panel-card members members-card">
    <div className="panel-head">
      <div className="ico"><I2 name="users" size={14}/></div>
      <div className="title-block">
        <div className="title">Members</div>
        <div className="sub">{memberIds.length} in this room</div>
      </div>
    </div>
    <div className="members-list">
      {memberIds.map(id => {
        const m = P2[id];
        if (!m) return null;
        if (m.kind === "agent") {
          return (
            <div key={id} className="member-row">
              <div className="av agent">{m.short}</div>
              <div className="name">
                {m.name}
                <span className="agent-mini">AGT</span>
                <span style={{ color: "var(--text-3)", fontSize: 11 }}>· op. {m.op}</span>
              </div>
              <div className="presence" title="reachable"/>
            </div>
          );
        }
        return (
          <div key={id} className="member-row">
            <div className="av" style={{ background: m.color, color: "white" }}>{m.initials}</div>
            <div className="name">
              {m.name}
              {m.origin && <span style={{ color: "var(--cross-tint)", fontSize: 11 }}>· {m.origin}</span>}
            </div>
            <div className={"presence" + (id === "u_kai" ? " away" : "")} title="reachable"/>
          </div>
        );
      })}
    </div>
  </div>
);

/* ============ Add-task modal ============ */
const AddTaskModal = ({ agentId, onClose, onSubmit }) => {
  const [desc, setDesc]     = React.useState("");
  const [priority, setPriority] = React.useState("normal");
  const [when, setWhen]     = React.useState("asap");
  const a = P2[agentId];

  React.useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="m-head">
          <h2>Add task — {a.name}</h2>
          <span className="meta">via panel</span>
          <button className="x" onClick={onClose}><I2 name="x" size={14}/></button>
        </div>
        <div className="m-body">
          <div className="field">
            <label>What should the agent do?</label>
            <textarea
              autoFocus
              placeholder="e.g. Check moisture on beds 8–10 and report back."
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
            />
          </div>
          <div className="field">
            <label>Priority</label>
            <div className="seg" role="radiogroup">
              {["low","normal","high"].map(p => (
                <button
                  key={p}
                  aria-pressed={priority === p ? "true" : "false"}
                  onClick={() => setPriority(p)}
                >{p}</button>
              ))}
            </div>
          </div>
          <div className="field">
            <label>When</label>
            <select value={when} onChange={(e) => setWhen(e.target.value)}>
              <option value="asap">As soon as possible</option>
              <option value="evening">Later today (evening)</option>
              <option value="tomorrow">Tomorrow morning</option>
              <option value="weekly">Add to weekly cycle</option>
            </select>
          </div>
        </div>
        <div className="m-foot">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={!desc.trim()}
            onClick={() => onSubmit({ title: desc.trim(), priority, when })}
          >
            <I2 name="plus" size={12}/> Add task
          </button>
        </div>
      </div>
    </div>
  );
};

Object.assign(window, { InlayRenderer, AgentPanel, CapabilitiesCard, MembersCard, AddTaskModal });
