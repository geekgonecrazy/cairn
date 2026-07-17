/* Video inlay — two modes:
   - mode "live"  : a live camera feed (e.g. garden cam). view-only, no recording, capability-bound.
   - mode "watch" : a synced shared movie/video session ("watch party").
   Shared: surface viewport, fullscreen theater, details modal. */

const { Icon: IV, AgentTag: ATV, CAIRN: CV } = window;
const PV = CV.PEOPLE;

/* ---------- helpers ---------- */
const _vEsc = (onClose) => {
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
};

const fmtClock = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p(m)}:${p(ss)}` : `${p(m)}:${p(ss)}`;
};

const _isRunning = (inlay) => inlay.state === "live" || inlay.state === "playing";

/* displayed elapsed/position in seconds, computed from base + wall-clock drift */
const useDisplaySec = (inlay) => {
  const running = _isRunning(inlay);
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [running, inlay.clockAt]);
  const base = inlay.posSec || 0;
  let v = running && inlay.clockAt ? base + (now - inlay.clockAt) / 1000 : base;
  if (inlay.durationSec != null) v = Math.min(v, inlay.durationSec);
  return v;
};

const _vAvatar = (id, size = 18) => {
  const p = PV[id];
  if (!p) return null;
  if (p.kind === "agent") return <span className="vid-av agent" style={{ width: size, height: size }}>{p.short}</span>;
  return <span className="vid-av" style={{ width: size, height: size, background: p.color }}>{p.initials}</span>;
};

const _names = (ids) => ids.map(id => PV[id]?.name).filter(Boolean);
const _nameList = (ids, you = "u_me") => {
  const list = ids.map(id => id === you ? "You" : PV[id]?.name).filter(Boolean);
  if (list.length <= 1) return list.join("");
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
};

/* ============================================================== */
/* ============ Video surface (the viewport) ============ */
/* ============================================================== */
const VideoSurface = ({ inlay, displaySec, size = "inlay", onSeek, onToggle, onMute, onExpand, showControls = true }) => {
  const isLive = inlay.mode === "live";
  const running = _isRunning(inlay);
  const ended = inlay.state === "ended";
  const wall = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

  const pct = (!isLive && inlay.durationSec)
    ? Math.max(0, Math.min(100, (displaySec / inlay.durationSec) * 100))
    : 0;

  const onBarClick = (e) => {
    if (isLive || !onSeek || ended) return;
    const r = e.currentTarget.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    onSeek(Math.round(frac * inlay.durationSec));
  };

  return (
    <div className={"vid-surface size-" + size} data-mode={inlay.mode} data-state={inlay.state}>
      {/* base scene */}
      {isLive ? (
        <div className="vid-scene cam"/>
      ) : (
        <div className="vid-scene movie" style={{ background: `linear-gradient(135deg, ${inlay.tone || "oklch(0.5 0.1 260)"}, ${inlay.tone2 || "oklch(0.35 0.1 280)"})` }}/>
      )}
      <div className="vid-hatch"/>
      <div className="vid-grain"/>
      {isLive && running && <div className="vid-scan"/>}
      <div className="vid-vignette"/>

      {/* center placeholder / poster */}
      <div className="vid-center">
        {isLive ? (
          <>
            <span className="vid-ph-glyph"><IV name="camera" size={20}/></span>
            <span className="vid-ph-text">garden-cam-03 · {running ? "live preview" : ended ? "feed closed" : "paused"}</span>
            <span className="vid-ph-sub">drop-in view · {inlay.resolution} · {inlay.fps}fps</span>
          </>
        ) : (
          <>
            <span className="vid-poster-title">{inlay.title}</span>
            <span className="vid-poster-sub">{inlay.year} · {fmtClock(inlay.durationSec)}{inlay.tag ? ` · ${inlay.tag}` : ""}</span>
          </>
        )}
      </div>

      {/* big play affordance when paused (watch) or ended */}
      {!isLive && !running && !ended && (
        <button className="vid-bigplay" onClick={(e) => { e.stopPropagation(); onToggle && onToggle(); }} aria-label="Play">
          <IV name="play" size={size === "theater" ? 30 : 22}/>
        </button>
      )}
      {ended && (
        <div className="vid-ended-veil"><span>{isLive ? "Feed closed" : "Session ended"}</span></div>
      )}

      {/* HUD corners */}
      <div className="vid-hud">
        <div className="vid-hud tl">
          {isLive ? (
            <span className="vid-badge live" data-state={inlay.state}>
              <span className="vid-live-dot"/>{running ? "LIVE" : ended ? "ENDED" : "PAUSED"}
            </span>
          ) : (
            <span className="vid-badge sync" data-state={inlay.state}>
              <IV name="sync" size={11}/>{inlay.synced && running ? "IN SYNC" : ended ? "ENDED" : "PAUSED"}
            </span>
          )}
          <span className="vid-loc">{isLive ? inlay.location : `hosted by ${PV[inlay.host || inlay.startedBy]?.name ?? "—"}`}</span>
        </div>
        <div className="vid-hud tr">
          {isLive && <span className="vid-chip mono">{wall}</span>}
          {!isLive && <span className="vid-chip mono">{(inlay.watchers || []).length} watching</span>}
        </div>
        <div className="vid-hud bl">
          {isLive ? (
            <>
              <span className="vid-sig"><i/><i/><i/><i/></span>
              <span className="vid-chip mono">{inlay.resolution} · {inlay.fps}fps</span>
            </>
          ) : (
            <span className="vid-chip mono">{fmtClock(displaySec)} / {fmtClock(inlay.durationSec)}</span>
          )}
          {inlay.audio && (
            <span className="vid-chip aud" data-muted={inlay.muted ? "true" : "false"}>
              <IV name={inlay.muted ? "micoff" : "mic"} size={11}/>
            </span>
          )}
        </div>
        <div className="vid-hud br">
          {isLive && <span className="vid-chip mono up">{fmtClock(displaySec)}</span>}
        </div>
      </div>

      {/* watch-mode player control bar */}
      {!isLive && showControls && !ended && (
        <div className="vid-player" onClick={(e) => e.stopPropagation()}>
          <button className="vid-pp" onClick={onToggle} aria-label={running ? "Pause" : "Play"}>
            <IV name={running ? "pause" : "play"} size={14}/>
          </button>
          <span className="vid-t mono">{fmtClock(displaySec)}</span>
          <div className="vid-bar" onClick={onBarClick}>
            <div className="vid-bar-fill" style={{ width: pct + "%" }}>
              <span className="vid-bar-knob"/>
            </div>
          </div>
          <span className="vid-t mono dim">{fmtClock(inlay.durationSec)}</span>
          <button className="vid-pp ghost" onClick={onMute} aria-label={inlay.muted ? "Unmute" : "Mute"}>
            <IV name={inlay.muted ? "micoff" : "mic"} size={13}/>
          </button>
          {onExpand && (
            <button className="vid-pp ghost" onClick={onExpand} aria-label="Expand">
              <IV name={size === "theater" ? "shrink" : "expand"} size={13}/>
            </button>
          )}
        </div>
      )}

      {/* expand hint (live or non-control surfaces) */}
      {onExpand && (isLive || size === "theater") && (
        <button className="vid-expand-hint" onClick={(e) => { e.stopPropagation(); onExpand(); }} aria-label="Expand">
          <IV name={size === "theater" ? "shrink" : "expand"} size={14}/>
        </button>
      )}
    </div>
  );
};

/* ============================================================== */
/* ============ Inline video inlay ============ */
/* ============================================================== */
const VideoInlay = ({ inlay, msgId, fromId, onUpdate, onExpand, onViewDetails }) => {
  const isLive = inlay.mode === "live";
  const running = _isRunning(inlay);
  const ended = inlay.state === "ended";
  const displaySec = useDisplaySec(inlay);
  const watchers = inlay.watchers || [];

  const stateChip = isLive
    ? (running ? { p: "negative", t: "live" } : ended ? { p: "neutral", t: "closed" } : { p: "busy", t: "paused" })
    : (running ? { p: "positive", t: "playing" } : ended ? { p: "neutral", t: "ended" } : { p: "busy", t: "paused" });

  return (
    <div className="vid-inlay" data-mode={inlay.mode} data-state={inlay.state}>
      <div className="vid-head">
        <div className="icon">
          <IV name={isLive ? "eye" : "film"} size={15}/>
        </div>
        <div className="title-block">
          <div className="title">
            {inlay.title}
            {isLive && <span className="vid-h-tag">live view</span>}
          </div>
          <div className="sub">
            <ATV id={fromId} showOp={false}/>
            <span className="dot"/>
            <span>{isLive ? "opened a camera feed" : `started a watch party`}</span>
            <span className="dot"/>
            <span>{watchers.length} watching</span>
          </div>
        </div>
        <span className="status-chip" data-polarity={stateChip.p}>
          <span className="swatch"/>{stateChip.t}
        </span>
      </div>

      {/* capability / session strip */}
      <div className="vid-strip" data-mode={inlay.mode}>
        {isLive ? (
          <>
            <span className="vid-strip-lock">VIEW-ONLY</span>
            <span className="vid-strip-why">
              <code>{inlay.capability}</code> · no recording · auto-revokes when this card is closed
            </span>
          </>
        ) : (
          <>
            <span className="vid-strip-lock pos">SYNCED</span>
            <span className="vid-strip-why">
              Playback is shared — play, pause and seek stay in step for everyone. Streamed peer-to-peer over LAN.
            </span>
          </>
        )}
      </div>

      {/* the surface — click to expand */}
      <div className="vid-surface-wrap" onClick={onExpand}>
        <VideoSurface
          inlay={inlay}
          displaySec={displaySec}
          size="inlay"
          onSeek={(s) => onUpdate(msgId, { seek: s })}
          onToggle={() => onUpdate(msgId, { toggle: true })}
          onMute={() => onUpdate(msgId, { toggleMute: true })}
          onExpand={onExpand}
        />
      </div>

      {/* watchers row */}
      <div className="vid-watchers">
        <div className="vid-stack">
          {watchers.slice(0, 5).map(id => (
            <span key={id} className="vid-stack-av">{_vAvatar(id, 22)}</span>
          ))}
        </div>
        <span className="vid-watchers-text">
          {watchers.length > 0 ? `${_nameList(watchers)} watching` : "no one watching yet"}
        </span>
      </div>

      {/* session actions */}
      {!ended ? (
        <div className="vid-actions">
          {isLive ? (
            <>
              <button className="vid-ico" aria-pressed={inlay.muted ? "true" : "false"} title={inlay.muted ? "Unmute" : "Mute"} onClick={() => onUpdate(msgId, { toggleMute: true })}>
                <IV name={inlay.muted ? "micoff" : "mic"} size={14}/>
              </button>
              <button className="vid-ico" title={running ? "Pause feed" : "Resume feed"} onClick={() => onUpdate(msgId, { toggle: true })}>
                <IV name={running ? "pause" : "play"} size={14}/>
              </button>
              <button className="btn sm" onClick={() => onUpdate(msgId, { snapshot: true })}>
                <IV name="snapshot" size={12}/> Snapshot
              </button>
              <button className="btn sm" onClick={onExpand}><IV name="expand" size={12}/> Expand</button>
              <button className="btn ghost sm" onClick={onViewDetails}><IV name="logs" size={12}/> Detail</button>
              <div className="grow"/>
              <button className="btn danger sm" onClick={() => onUpdate(msgId, { stop: true })}>Stop feed</button>
            </>
          ) : (
            <>
              <button className="btn sm" onClick={onExpand}><IV name="expand" size={12}/> Open theater</button>
              <button className="btn ghost sm" onClick={onViewDetails}><IV name="logs" size={12}/> Detail</button>
              <div className="grow"/>
              <button className="btn danger sm" onClick={() => onUpdate(msgId, { stop: true })}>Leave</button>
            </>
          )}
        </div>
      ) : (
        <div className="vid-actions">
          <button className="btn ghost sm" onClick={onViewDetails}><IV name="logs" size={12}/> Detail</button>
          <div className="grow"/>
          <button className="btn sm" onClick={() => onUpdate(msgId, { restart: true })}>
            <IV name={isLive ? "eye" : "play"} size={12}/> {isLive ? "Reopen" : "Watch again"}
          </button>
        </div>
      )}
    </div>
  );
};

/* ============================================================== */
/* ============ Fullscreen theater ============ */
/* ============================================================== */
const VideoTheater = ({ inlay, msgId, fromId, onClose, onUpdate }) => {
  _vEsc(onClose);
  const displaySec = useDisplaySec(inlay);
  const isLive = inlay.mode === "live";
  const running = _isRunning(inlay);
  const watchers = inlay.watchers || [];

  return (
    <div className="vid-theater-scrim" onClick={onClose}>
      <div className="vid-theater" onClick={(e) => e.stopPropagation()}>
        <VideoSurface
          inlay={inlay}
          displaySec={displaySec}
          size="theater"
          onSeek={(s) => onUpdate(msgId, { seek: s })}
          onToggle={() => onUpdate(msgId, { toggle: true })}
          onMute={() => onUpdate(msgId, { toggleMute: true })}
        />
        <div className="vid-theater-bar">
          <div className="vid-theater-title">
            <div className="t">{inlay.title}</div>
            <div className="s">
              {isLive ? <>Live from {inlay.location}</> : <>Hosted by {PV[inlay.host || inlay.startedBy]?.name ?? "—"}</>}
              <span className="dot"/>
              {_nameList(watchers)} watching
            </div>
          </div>
          <div className="grow"/>
          {isLive && (
            <button className="btn sm" onClick={() => onUpdate(msgId, { snapshot: true })}>
              <IV name="snapshot" size={12}/> Snapshot
            </button>
          )}
          <button className="vid-ico" title={inlay.muted ? "Unmute" : "Mute"} aria-pressed={inlay.muted ? "true" : "false"} onClick={() => onUpdate(msgId, { toggleMute: true })}>
            <IV name={inlay.muted ? "micoff" : "mic"} size={14}/>
          </button>
          <button className="btn" onClick={onClose}><IV name="shrink" size={12}/> Close</button>
        </div>
      </div>
    </div>
  );
};

/* ============================================================== */
/* ============ Details modal ============ */
/* ============================================================== */
const VideoDetailsModal = ({ inlay, fromId, onClose, onUpdate, msgId }) => {
  _vEsc(onClose);
  const isLive = inlay.mode === "live";
  const displaySec = useDisplaySec(inlay);
  const watchers = inlay.watchers || [];
  const host = PV[inlay.host || inlay.startedBy];
  const startTimeLabel = inlay.openedAt ?? "—";

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal detail" onClick={(e) => e.stopPropagation()}>

        <div className="m-head">
          <div className="lockup">
            <div className={"icon-wrap vid " + (isLive ? "live" : "watch")}>
              <IV name={isLive ? "eye" : "film"} size={18}/>
            </div>
            <div>
              <h2>{isLive ? "Live camera view" : "Watch party"}</h2>
              <div className="sub">
                {isLive ? "Opened by " : "Hosted by "}<ATV id={inlay.host || fromId} showOp={false}/>
                <span className="dot"/>
                <span>{inlay.title}</span>
                <span className="dot"/>
                <span>{isLive ? "view-only · no recording" : "playback synced over LAN"}</span>
              </div>
            </div>
          </div>
          <button className="x" onClick={onClose}><IV name="x" size={14}/></button>
        </div>

        <div className="m-body">

          {/* live preview inside the modal */}
          <div className="detail-section">
            <div className="label">{isLive ? "Current feed" : "Now playing"}</div>
            <div className="vid-modal-surface">
              <VideoSurface
                inlay={inlay}
                displaySec={displaySec}
                size="inlay"
                onSeek={msgId ? (s) => onUpdate(msgId, { seek: s }) : undefined}
                onToggle={msgId ? () => onUpdate(msgId, { toggle: true }) : undefined}
                onMute={msgId ? () => onUpdate(msgId, { toggleMute: true }) : undefined}
              />
            </div>
          </div>

          {/* summary */}
          <div className="detail-section">
            <div className="label">{isLive ? "Feed" : "Session"} summary</div>
            <div className="scope-grid">
              {isLive ? (
                <>
                  <div className="k">Source</div>
                  <div className="v"><code>{inlay.camera}</code> · {inlay.location}</div>
                  <div className="k">Quality</div>
                  <div className="v">{inlay.resolution} · {inlay.fps}fps · audio {inlay.audio ? "on" : "off"}</div>
                  <div className="k">Opened</div>
                  <div className="v"><code>{startTimeLabel}</code> by {host?.name ?? "—"}</div>
                  <div className="k">Uptime</div>
                  <div className="v">{_isRunning(inlay) ? <span style={{ color: "var(--pos)" }}>{fmtClock(displaySec)} · streaming</span> : <span style={{ color: "var(--text-3)" }}>paused / closed</span>}</div>
                  <div className="k">Recording</div>
                  <div className="v" style={{ color: "var(--pos)" }}>Off — Cairn never records this feed.</div>
                </>
              ) : (
                <>
                  <div className="k">Title</div>
                  <div className="v">{inlay.title} · {inlay.year}</div>
                  <div className="k">Runtime</div>
                  <div className="v">{fmtClock(inlay.durationSec)} · at {fmtClock(displaySec)} now</div>
                  <div className="k">Host</div>
                  <div className="v">{host?.name ?? "—"} · controls playback for the room</div>
                  <div className="k">Source</div>
                  <div className="v"><code>{inlay.source || "household library"}</code></div>
                  <div className="k">Sync</div>
                  <div className="v" style={{ color: "var(--pos)" }}>In step for all {watchers.length} watchers</div>
                </>
              )}
            </div>
          </div>

          {/* capability (live only) */}
          {isLive && (
            <div className="detail-section">
              <div className="label">Capability in use</div>
              <div className="cap-target">
                <span className="verb">camera.stream</span>
                <span style={{ color: "var(--text-3)" }}>(</span>
                <span className="arg">{inlay.camera}</span>
                <span style={{ color: "var(--text-3)" }}>)</span>
                <span className="scope-tag">view-only</span>
              </div>
              <div className="cap-explain">
                Streams frames from the bed-3 camera to people in <code style={{ fontFamily: "var(--font-mono)" }}>#garden</code> while this card is open.
                Nothing is written to disk; closing the card revokes the grant immediately.
              </div>
            </div>
          )}

          {/* watchers */}
          <div className="detail-section">
            <div className="label">Watching now</div>
            <div className="participant-table">
              {watchers.map(id => {
                const p = PV[id];
                if (!p) return null;
                const isHost = id === (inlay.host || inlay.startedBy);
                return (
                  <div className="pt-row" key={id}>
                    <div className="pt-who">
                      {_vAvatar(id, 28)}
                      <div className="pt-name">
                        {id === "u_me" ? "You" : p.name}
                        {p.kind === "agent" && <span className="agt-mini">AGT</span>}
                        <div className="pt-id">@{id.replace(/^[au]_/, "")}</div>
                      </div>
                    </div>
                    <div className="pt-state pos"><span className="pip"/>{isHost ? (isLive ? "opened the feed" : "hosting") : "watching"}</div>
                    <div className="pt-meta"><span className="pt-flag">{inlay.muted && id === "u_me" ? "muted" : "in sync"}</span></div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* why / provenance */}
          <div className="detail-section">
            <div className="label">{isLive ? "Why this is open" : "How we got here"}</div>
            <div className="provenance">
              {(inlay.provenance || []).map((row, i) => (
                <div className="row" key={i}>
                  <span className="ico"><IV name={row.icon || "info"} size={14}/></span>
                  <span dangerouslySetInnerHTML={{ __html: row.text }}/>
                  <span className="meta">{row.t}</span>
                </div>
              ))}
            </div>
          </div>

        </div>

        <div className="m-foot">
          {isLive ? (
            <span className="timer"><IV name="shield" size={11}/> revokes on close</span>
          ) : (
            <span className="timer" style={{ color: "var(--pos)", background: "var(--pos-soft)", borderColor: "color-mix(in oklab, var(--pos) 30%, var(--border))" }}>
              <IV name="sync" size={11}/> synced
            </span>
          )}
          <span className="grow"/>
          {msgId && _isRunning(inlay) && (
            <button className="btn danger" onClick={() => { onUpdate(msgId, { stop: true }); }}>
              {isLive ? "Stop feed" : "End session"}
            </button>
          )}
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
};

Object.assign(window, { VideoSurface, VideoInlay, VideoTheater, VideoDetailsModal });
