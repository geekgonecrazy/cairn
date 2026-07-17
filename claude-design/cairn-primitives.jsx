/* §A — Inlay primitive vocabulary + composed cards (greenhouse) + widget placeholder.
   The author supplies MEANING (numbers, series, status, actions); the client owns every pixel.
   These primitives are the shared visual family every card is assembled from. */
const { Icon: PI, CAIRN: PC } = window;
const PAT = (props) => React.createElement(window.AgentTag, props);
const PPL = PC.PEOPLE;

/* ---------- relative-time helper ---------- */
function relTime(mins) {
  if (mins == null) return "";
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/* ============ PRIMITIVES ============ */

/* number — a scalar value, optional unit + trend delta */
const PrimNumber = ({ value, unit, delta, trend }) => (
  <span className="prim-num">
    <span className="pn-v">{value}</span>
    {unit && <span className="pn-u">{unit}</span>}
    {delta != null && (
      <span className={"pn-d " + (trend || "flat")}>
        {trend === "up" ? "↑" : trend === "down" ? "↓" : "→"}{delta}
      </span>
    )}
  </span>
);

/* progress_fraction — reuse the panel task bar look */
const PrimProgress = ({ value, label, polarity = "accent" }) => {
  const pct = Math.max(0, Math.min(100, Math.round((value ?? 0) * 100)));
  return (
    <div className="prim-prog" data-polarity={polarity} role="progressbar" aria-valuenow={pct} aria-valuemin="0" aria-valuemax="100">
      <div className="pp-track"><div className="pp-fill" style={{ width: pct + "%" }}/></div>
      <span className="pp-pct">{label ?? pct + "%"}</span>
    </div>
  );
};

/* status_enum — state chip (icon + color) with polarity pos/neutral/neg/busy */
const PrimStatus = ({ label, polarity = "neutral", icon }) => (
  <span className="status-chip" data-polarity={polarity}>
    {icon ? <PI name={icon} size={11}/> : <span className="swatch"/>}
    {label}
  </span>
);

/* timestamp — relative, with absolute on hover/aside */
const PrimTime = ({ mins, abs, showAbs }) => (
  <span className="prim-ts" title={abs || ""}>
    {relTime(mins)}{showAbs && abs ? <span className="pt-abs"> · {abs}</span> : null}
  </span>
);

/* series — a sparkline over a normalized data array */
const Sparkline = ({ data = [], width = 128, height = 32, polarity = "accent", band }) => {
  if (data.length < 2) return <div className="spark spark-empty" style={{ width, height }}/>;
  const min = Math.min(...data), max = Math.max(...data);
  const span = (max - min) || 1;
  const stepX = width / (data.length - 1);
  const y = (v) => height - 3 - ((v - min) / span) * (height - 6);
  const pts = data.map((v, i) => [i * stepX, y(v)]);
  const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const area = line + ` L ${width} ${height} L 0 ${height} Z`;
  const stroke = polarity === "pos" ? "var(--pos)" : polarity === "neg" ? "var(--neg)" : polarity === "busy" ? "var(--busy)" : "var(--accent)";
  const last = pts[pts.length - 1];
  const uid = "sg" + Math.abs(data.reduce((a, b) => a + b, 0) * 7 % 99999 | 0);
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={uid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={stroke} stopOpacity="0.22"/>
          <stop offset="1" stopColor={stroke} stopOpacity="0"/>
        </linearGradient>
      </defs>
      {band && (
        <rect x="0" y={y(band[1])} width={width} height={Math.max(1, y(band[0]) - y(band[1]))} fill="var(--pos)" opacity="0.08"/>
      )}
      <path d={area} fill={`url(#${uid})`}/>
      <path d={line} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round"/>
      <circle cx={last[0]} cy={last[1]} r="2.2" fill={stroke}/>
    </svg>
  );
};

/* image_cid — a thumbnail with loading / placeholder / broken states (see §F) */
const PrimThumb = ({ tone, tone2, label, state = "ready", size = 46 }) => (
  <div className={"prim-thumb state-" + state} style={{ width: size, height: size, "--pt-a": tone, "--pt-b": tone2 }} aria-label={label}>
    {state === "loading" && <span className="pt-shim"/>}
    {state === "broken" && <PI name="image" size={16}/>}
  </div>
);

/* action_ref — button; read-only OR capability-bound (discloses capability+scope before click) */
const PrimAction = ({ label, icon, variant = "default", opens, capability, scope, onAct }) => (
  <button
    className={"btn sm prim-act " + (variant === "primary" ? "primary" : variant === "danger" ? "danger" : variant === "ghost" ? "ghost" : "")}
    data-cap={capability ? "true" : "false"}
    onClick={onAct}
    title={capability ? `Authorizes ${capability} — ${scope}` : undefined}
  >
    {capability && <PI name="key" size={11}/>}
    {icon && !capability && <PI name={icon} size={11}/>}
    {label}
    {opens && <span className="pa-opens" aria-hidden="true">…</span>}
  </button>
);

/* record — a labelled field group; each value is itself a primitive node */
const PrimRecord = ({ fields, cols = 2 }) => (
  <div className="prim-record" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))` }}>
    {fields.map((f) => (
      <div className="pr-field" key={f.k} data-flag={f.flag || "none"}>
        <div className="pr-k">{f.k}</div>
        <div className="pr-v">{f.node}</div>
        {f.note && <div className="pr-note">{f.note}</div>}
      </div>
    ))}
  </div>
);

Object.assign(window, { PrimNumber, PrimProgress, PrimStatus, PrimTime, Sparkline, PrimThumb, PrimAction, PrimRecord, relTime });

/* Persist each greenhouse card's phase/values across remounts. The host re-creates the
   inlay render-prop on every app render (task simulator ticks every ~2.5s), which would
   otherwise remount this card and restart it at `loading` on a loop. */
const ghCache = {};

/* ============ NOVEL CARD: Greenhouse readings ============
   Composed purely from primitives: a `record` of `number`s + a `series` sparkline +
   a `status_enum`, plus one read-only and one capability-bound `action_ref`.
   Demonstrates the calm states: loading → rendered → updating, with error / text-fallback. */
const GreenhouseCard = ({ inlay, fromId, onViewDetails, onCapabilityAction }) => {
  const key = inlay.title || "gh";
  if (!ghCache[key]) {
    ghCache[key] = {
      phase: inlay.state || "rendered",
      readings: inlay.readings, series: inlay.series, status: inlay.status,
      startedAt: Date.now(),
    };
  }
  const cache = ghCache[key];
  const [phase, setPhaseRaw] = React.useState(cache.phase); /* loading | rendered | error | text-fallback */
  const [readings, setReadingsRaw] = React.useState(cache.readings);
  const [series, setSeriesRaw] = React.useState(cache.series);
  const [pulse, setPulse] = React.useState(false);
  const [status, setStatusRaw] = React.useState(cache.status);
  /* mirror every change into the cache so a remount restores, not resets */
  const setPhase = (v) => { const nv = typeof v === "function" ? v(phase) : v; cache.phase = nv; if (nv === "loading") cache.startedAt = Date.now(); setPhaseRaw(nv); };
  const setReadings = (v) => setReadingsRaw((p) => { const nv = typeof v === "function" ? v(p) : v; cache.readings = nv; return nv; });
  const setSeries = (v) => setSeriesRaw((p) => { const nv = typeof v === "function" ? v(p) : v; cache.series = nv; return nv; });
  const setStatus = (v) => setStatusRaw((p) => { const nv = typeof v === "function" ? v(p) : v; cache.status = nv; return nv; });

  /* loading → rendered, using a persisted timestamp so it only ever plays once
     (remounts within the loading window resolve on the remaining time, not a fresh 1.4s) */
  React.useEffect(() => {
    if (phase !== "loading") return;
    const remain = Math.max(0, 1400 - (Date.now() - (cache.startedAt || Date.now())));
    const id = setTimeout(() => setPhase("rendered"), remain);
    return () => clearTimeout(id);
  }, [phase]);

  /* calm, debounced live updating (~5s) while rendered */
  React.useEffect(() => {
    if (phase !== "rendered") return;
    const id = setInterval(() => {
      setReadings((prev) => prev.map((r) => {
        if (r.n == null || !r.live) return r;
        const jitter = (Math.random() - 0.5) * r.step;
        const n = Math.round((r.n + jitter) * 10) / 10;
        const trend = n > r.n ? "up" : n < r.n ? "down" : "flat";
        return { ...r, n, trend, delta: Math.abs(Math.round((n - r.n) * 10) / 10) };
      }));
      setSeries((prev) => prev ? [...prev.slice(1), prev[prev.length - 1] + (Math.random() - 0.45) * 0.6] : prev);
      /* single calm pulse to signal the quiet refresh */
      setPulse(true);
      setTimeout(() => setPulse(false), 640);
    }, 5000);
    return () => clearInterval(id);
  }, [phase]);

  const agent = PPL[fromId];

  /* text-fallback — the mandatory single readable line */
  if (phase === "text-fallback") {
    return (
      <div className="inlay gh-inlay" data-phase="text-fallback">
        <div className="gh-fallback">
          <PI name="leaf" size={14}/>
          <span>{inlay.fallback}</span>
          <button className="btn ghost sm" onClick={() => setPhase("rendered")}>Show card</button>
        </div>
      </div>
    );
  }

  /* error / unavailable — degrade to one calm line, never an endless spinner */
  if (phase === "error") {
    return (
      <div className="inlay gh-inlay" data-phase="error">
        <div className="gh-fallback err">
          <PI name="warning" size={14}/>
          <span>{inlay.fallback} <span className="gh-err-note">— readings unavailable (sensor bridge offline)</span></span>
          <button className="btn sm" onClick={() => setPhase("loading")}>
            <PI name="sync" size={11}/> Retry
          </button>
        </div>
      </div>
    );
  }

  const loading = phase === "loading";

  return (
    <div className={"inlay gh-inlay" + (pulse ? " pulse" : "")} data-phase={phase} role="group" aria-label={inlay.title} aria-busy={loading ? "true" : "false"}>
      <div className="gh-head">
        <div className="gh-ico"><PI name="leaf" size={15}/></div>
        <div className="gh-title-block">
          <div className="gh-title">{inlay.title}</div>
          <div className="gh-sub">
            <PAT id={fromId} showOp={false}/>
            <span className="dot"/>
            {loading ? <span className="gh-updating">syncing…</span>
              : <PrimTime mins={inlay.updatedMins} abs={inlay.updatedAbs}/>}
          </div>
        </div>
        {loading
          ? <span className="status-chip" data-polarity="busy"><span className="swatch"/>loading</span>
          : <PrimStatus label={status.label} polarity={status.polarity} icon={status.icon}/>}
      </div>

      {loading ? (
        <div className="gh-skeleton">
          <div className="sk-grid">{[0,1,2,3].map(i => <div className="sk-cell" key={i}><span className="sk-k"/><span className="sk-v"/></div>)}</div>
          <div className="sk-spark"/>
        </div>
      ) : (
        <>
          {/* record of numbers */}
          <PrimRecord
            cols={2}
            fields={readings.filter(r => r.n != null).map((r) => ({
              k: r.k,
              flag: r.flag,
              node: <PrimNumber value={r.disp ? r.disp(r.n) : r.n} unit={r.unit} delta={r.delta} trend={r.trend}/>,
              note: r.note,
            }))}
          />

          {/* series sparkline */}
          <div className="gh-series">
            <div className="gh-series-head">
              <span className="gh-series-k">{inlay.seriesLabel}</span>
              <span className="gh-series-legend"><span className="ln band"/> healthy band</span>
            </div>
            <Sparkline data={series} width={520} height={44} polarity="pos" band={inlay.seriesBand}/>
          </div>

          {/* offline sensor row → per-field degradation to a readable line */}
          {readings.some(r => r.n == null) && (
            <div className="gh-offline">
              <PI name="warning" size={12}/>
              {readings.filter(r => r.n == null).map(r => r.k).join(", ")} unavailable — sensor not reporting.
            </div>
          )}

          {/* actions: read-only + capability-bound (discloses before click) */}
          <div className="gh-actions">
            <PrimAction label="Refresh" icon="sync" variant="ghost" onAct={() => { setPulse(true); setTimeout(() => setPulse(false), 640); }}/>
            <PrimAction label="History" icon="logs" variant="default" opens onAct={onViewDetails}/>
            <span className="gh-grow"/>
            <div className="gh-cap-wrap">
              <div className="gh-cap-disclose">
                <PI name="key" size={11}/>
                authorizes <code>{inlay.capAction.capability}</code> · {inlay.capAction.scope}
              </div>
              <PrimAction
                label={inlay.capAction.label}
                variant="primary"
                opens
                capability={inlay.capAction.capability}
                scope={inlay.capAction.scope}
                onAct={() => onCapabilityAction?.(inlay.capAction)}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
};

/* ============ WIDGET PLACEHOLDER ============
   A rich sandboxed mini-app never runs inline — the timeline shows only a
   placeholder + Open button. */
const WidgetPlaceholder = ({ inlay, fromId, onOpen }) => (
  <div className="inlay widget-inlay" role="group" aria-label={inlay.title}>
    <div className="wg-preview" style={{ "--wg-a": inlay.tone, "--wg-b": inlay.tone2 }} aria-hidden="true">
      <div className="wg-glyph"><PI name={inlay.icon || "monitor"} size={20}/></div>
      <div className="wg-chip">WIDGET</div>
    </div>
    <div className="wg-body">
      <div className="wg-title">{inlay.title}</div>
      <div className="wg-sub"><PAT id={fromId} showOp={false}/><span className="dot"/>{inlay.sub}</div>
      <div className="wg-fallback">{inlay.fallback}</div>
      <div className="wg-foot">
        <button className="btn sm primary" onClick={onOpen}><PI name="expand" size={11}/> Open</button>
        <span className="wg-sandbox"><PI name="shield" size={11}/> sandboxed · runs only when opened</span>
      </div>
    </div>
  </div>
);

Object.assign(window, { GreenhouseCard, WidgetPlaceholder });
