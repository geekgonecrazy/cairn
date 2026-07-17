/* §B + §C — Settings surface (identity/devices · notifications · transports · appearance),
   plus the onboarding & device-pairing flows it links to (recovery code, pair new device,
   trusted-device confirm, parent-sets-up-kid, link-radio wizard). Content is hardcoded. */
const { Icon: SI } = window;

/* deterministic pseudo-QR: a grid of squares with corner finders (squares only, no art) */
const QRBlock = ({ seed = "cairn", size = 168 }) => {
  const N = 25;
  const cells = [];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const rnd = (i) => { const x = Math.sin(h + i * 12.9898) * 43758.5453; return x - Math.floor(x); };
  const finder = (r, c) => (r < 7 && c < 7) || (r < 7 && c >= N - 7) || (r >= N - 7 && c < 7);
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    if (finder(r, c)) continue;
    if (rnd(r * N + c) > 0.55) cells.push(<rect key={r + "-" + c} x={c} y={r} width="1" height="1"/>);
  }
  const Finder = ({ x, y }) => (
    <g transform={`translate(${x} ${y})`}>
      <rect x="0" y="0" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1"/>
      <rect x="2" y="2" width="3" height="3"/>
    </g>
  );
  return (
    <svg className="qr-svg" width={size} height={size} viewBox={`-1 -1 ${N + 2} ${N + 2}`} shapeRendering="crispEdges" aria-label="Pairing QR code">
      <rect x="-1" y="-1" width={N + 2} height={N + 2} fill="#fff"/>
      <g fill="#0b0d12">
        {cells}
        <Finder x={0} y={0}/>
        <Finder x={N - 7} y={0}/>
        <Finder x={0} y={N - 7}/>
      </g>
    </svg>
  );
};

/* 24-word recovery mnemonic (hardcoded sample) */
const RECOVERY_WORDS = [
  "harbor","cinder","maple","quartz","velvet","tunnel","orchid","pebble",
  "glacier","ribbon","cobalt","thistle","marrow","lantern","fathom","willow",
  "cipher","meadow","anchor","bramble","kestrel","opaque","driftwood","summit",
];

const DEVICES = [
  { id: "d1", name: "Aaron's laptop",  kind: "device",  fp: "7F2A·91C4·DE08", last: "now",        here: true  },
  { id: "d2", name: "Aaron's phone",   kind: "device",  fp: "B3D1·55E9·0A7C", last: "12m ago",    here: false },
  { id: "d3", name: "Kitchen tablet",  kind: "monitor", fp: "9C48·2E10·FF33", last: "2h ago",     here: false },
  { id: "d4", name: "Old phone",       kind: "device",  fp: "1A0B·77D2·4E55", last: "34d ago",    here: false, stale: true },
];

const TRANSPORTS = [
  { id: "lan",  name: "LAN",        code: "lan0",       icon: "house", state: "active",     note: "home network", peers: 4 },
  { id: "iroh", name: "iroh",       code: "relay",      icon: "link",  state: "active",     note: "direct + relay", peers: 2 },
  { id: "ble",  name: "Bluetooth",  code: "ble",        icon: "wifi",  state: "available",  note: "low-power fallback", peers: 1 },
  { id: "mesh", name: "Meshtastic", code: "lora",       icon: "radio", state: "not-linked", note: "no radio linked", peers: 0 },
];

const WAKE_ROWS = [
  { k: "Direct messages & chat",   sub: "new messages in your rooms",       level: "quiet"  },
  { k: "Approvals",                sub: "an agent needs your authorization", level: "wake"   },
  { k: "Incoming calls",           sub: "someone is calling you",            level: "wake", locked: true },
  { k: "Presence",                 sub: "people arriving / leaving",         level: "never"  },
  { k: "Routine agent updates",    sub: "progress, trend reports",           level: "never"  },
];

/* ============ Settings surface ============ */
const SettingsModal = ({ onClose, theme, onTheme, density, onDensity }) => {
  const [cat, setCat] = React.useState("identity");
  const [view, setView] = React.useState("main"); /* main | recovery | pair | trusted | parent | linkradio */
  const [cloudPush, setCloudPush] = React.useState(false);
  const [voip, setVoip] = React.useState(false);
  const [wake, setWake] = React.useState(() => Object.fromEntries(WAKE_ROWS.map((r, i) => [i, r.level])));
  const [confirmRevoke, setConfirmRevoke] = React.useState(null);

  React.useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") { if (view !== "main") setView("main"); else onClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, view]);

  if (view === "recovery") return <RecoveryScreen onDone={() => setView("main")} onClose={() => setView("main")}/>;
  if (view === "pair")      return <PairDeviceScreen onClose={() => setView("main")}/>;
  if (view === "trusted")   return <TrustedConfirmScreen onClose={() => setView("main")}/>;
  if (view === "parent")    return <ParentSetupScreen onClose={() => setView("main")}/>;
  if (view === "linkradio") return <LinkRadioWizard onClose={() => setView("main")}/>;

  const cats = [
    { id: "identity", label: "Identity & devices", icon: "key"   },
    { id: "notif",    label: "Notifications",       icon: "bell"  },
    { id: "transports", label: "Transports",        icon: "radio" },
    { id: "appearance", label: "Appearance",        icon: "sliders" },
  ];

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal detail settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="m-head">
          <div className="lockup">
            <div className="icon-wrap settings"><SI name="settings" size={18}/></div>
            <div>
              <h2>Settings</h2>
              <div className="sub">Aaron · this household<span className="dot"/>Cairn identity</div>
            </div>
          </div>
          <button className="x" onClick={onClose}><SI name="x" size={16}/></button>
        </div>

        <div className="settings-split">
          <nav className="settings-rail">
            {cats.map(c => (
              <button key={c.id} className="sr-item" data-active={cat === c.id ? "true" : "false"} onClick={() => setCat(c.id)}>
                <SI name={c.icon} size={15}/> {c.label}
              </button>
            ))}
          </nav>

          <div className="settings-body">
            {cat === "identity" && (
              <IdentityPanel
                onRecovery={() => setView("recovery")}
                onPair={() => setView("pair")}
                onTrusted={() => setView("trusted")}
                onParent={() => setView("parent")}
                confirmRevoke={confirmRevoke}
                setConfirmRevoke={setConfirmRevoke}
              />
            )}
            {cat === "notif" && (
              <NotifPanel cloudPush={cloudPush} setCloudPush={setCloudPush} voip={voip} setVoip={setVoip} wake={wake} setWake={setWake}/>
            )}
            {cat === "transports" && <TransportsPanel onLinkRadio={() => setView("linkradio")}/>}
            {cat === "appearance" && <AppearancePanel theme={theme} onTheme={onTheme} density={density} onDensity={onDensity}/>}
          </div>
        </div>
      </div>
    </div>
  );
};

/* ---- Identity & devices ---- */
const IdentityPanel = ({ onRecovery, onPair, onTrusted, onParent, confirmRevoke, setConfirmRevoke }) => (
  <>
    <div className="detail-section">
      <div className="label">Attested — cannot be changed</div>
      <div className="attest-grid">
        <div className="attest locked">
          <div className="at-k"><SI name="shield" size={12}/> Kind</div>
          <div className="at-v">human</div>
          <div className="at-note">Cryptographically attested at first pairing</div>
        </div>
        <div className="attest locked">
          <div className="at-k"><SI name="house" size={12}/> Origin</div>
          <div className="at-v">your household</div>
          <div className="at-note">Root of trust · shown to peers as your origin</div>
        </div>
      </div>
    </div>

    <div className="detail-section">
      <div className="label">Your profile — editable claims</div>
      <div className="field"><label>Display name</label><input type="text" defaultValue="Aaron"/></div>
      <div className="field" style={{ marginTop: 10 }}><label>Description</label><input type="text" defaultValue="Household admin · runs Garden & Ops agents"/></div>
      <div className="claims-note"><SI name="info" size={12}/> These are claims other people see. They are not attested — a peer trusts them because they trust your origin.</div>
    </div>

    <div className="detail-section">
      <div className="label">Paired devices</div>
      <div className="dev-list">
        {DEVICES.map(d => (
          <div key={d.id} className={"dev-row" + (d.stale ? " stale" : "")}>
            <div className="dev-ico"><SI name={d.kind} size={15}/></div>
            <div className="dev-main">
              <div className="dev-name">{d.name}{d.here && <span className="dev-here">this device</span>}</div>
              <div className="dev-meta"><code>{d.fp}</code><span className="dot"/>last seen {d.last}</div>
            </div>
            {!d.here && (
              confirmRevoke === d.id ? (
                <div className="dev-confirm">
                  <span>Revoke?</span>
                  <button className="btn danger sm" onClick={() => setConfirmRevoke(null)}>Revoke</button>
                  <button className="btn ghost sm" onClick={() => setConfirmRevoke(null)}>Keep</button>
                </div>
              ) : (
                <button className="btn ghost sm" onClick={() => setConfirmRevoke(d.id)}>Revoke</button>
              )
            )}
          </div>
        ))}
      </div>
      <div className="dev-actions">
        <button className="btn sm" onClick={onPair}><SI name="qr" size={12}/> Pair a new device</button>
        <button className="btn sm ghost" onClick={onParent}><SI name="person" size={12}/> Set up someone's device</button>
        <button className="btn sm ghost" onClick={onTrusted}><SI name="device" size={12}/> Confirm request</button>
      </div>
    </div>

    <div className="detail-section">
      <div className="label">Recovery</div>
      <div className="recovery-tile">
        <div className="rt-ico"><SI name="key" size={16}/></div>
        <div className="rt-body">
          <div className="rt-t">Recovery code</div>
          <div className="rt-s">A 24-word phrase is the only way to restore this identity. If it's lost, the identity is gone — there is no reset.</div>
        </div>
        <button className="btn sm" onClick={onRecovery}>View / regenerate</button>
      </div>
    </div>
  </>
);

/* ---- Notifications ---- */
const Toggle = ({ on, onChange, tone }) => (
  <button className={"sw" + (on ? " on" : "")} data-tone={tone || "accent"} role="switch" aria-checked={on} onClick={() => onChange(!on)}>
    <span className="sw-knob"/>
  </button>
);

const NotifPanel = ({ cloudPush, setCloudPush, voip, setVoip, wake, setWake }) => (
  <>
    <div className="detail-section">
      <div className="label">Cloud push</div>
      <div className="notif-row">
        <div className="nr-main">
          <div className="nr-t">Cloud push notifications</div>
          <div className="nr-s">Off by default. Cairn works on your local mesh without any cloud service.</div>
        </div>
        <Toggle on={cloudPush} onChange={setCloudPush}/>
      </div>
      {!cloudPush && (
        <div className="honesty"><SI name="info" size={13}/> You won't get alerts when away from home and off the mesh. Turn this on to opt in to cloud delivery.</div>
      )}
      <div className="notif-row" style={{ marginTop: 8 }}>
        <div className="nr-main">
          <div className="nr-t">VoIP push for calls</div>
          <div className="nr-s">Wake the device for incoming calls even when backgrounded.</div>
        </div>
        <Toggle on={voip} onChange={setVoip}/>
      </div>
    </div>

    <div className="detail-section">
      <div className="label">Wake matrix — how hard each event tries to reach you</div>
      <div className="wake-list">
        {WAKE_ROWS.map((r, i) => (
          <div className="wake-row" key={i}>
            <div className="wake-main">
              <div className="wake-k">{r.k}{r.locked && <span className="wake-lock"><SI name="lock" size={10}/> locked</span>}</div>
              <div className="wake-s">{r.sub}</div>
            </div>
            <div className="seg wake-seg" role="radiogroup">
              {["never","quiet","wake"].map(lv => (
                <button key={lv}
                  aria-pressed={wake[i] === lv ? "true" : "false"}
                  disabled={r.locked}
                  onClick={() => !r.locked && setWake(w => ({ ...w, [i]: lv }))}>
                  {lv === "wake" ? "wake" : lv}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="claims-note"><SI name="info" size={12}/> Global defaults. Per-room mute in Room settings overrides these.</div>
    </div>
  </>
);

/* ---- Transports ---- */
const TransportsPanel = ({ onLinkRadio }) => (
  <>
    <div className="detail-section">
      <div className="label">Transports</div>
      <div className="transp-list">
        {TRANSPORTS.map(t => (
          <div key={t.id} className="transp-row" data-state={t.state}>
            <div className="tr-ico"><SI name={t.icon} size={15}/></div>
            <div className="tr-main">
              <div className="tr-name">{t.name} <code>{t.code}</code></div>
              <div className="tr-note">{t.note}{t.peers > 0 && <> · {t.peers} peer{t.peers !== 1 ? "s" : ""} nearby</>}</div>
            </div>
            <span className={"transp-state s-" + t.state}>
              <span className="ts-pip"/>{t.state === "not-linked" ? "not linked" : t.state}
            </span>
          </div>
        ))}
      </div>
      <div className="dev-actions">
        <button className="btn sm" onClick={onLinkRadio}><SI name="plus" size={12}/> Link radio</button>
      </div>
    </div>

    <div className="detail-section">
      <div className="label">Broadcast preferences</div>
      <div className="bcast-list">
        <div className="bcast-row"><div className="bc-main"><div className="bc-t">Presence beacons</div><div className="bc-s">Announce reachability to nearby peers</div></div><Toggle on={true} onChange={() => {}}/></div>
        <div className="bcast-row"><div className="bc-main"><div className="bc-t">Room discovery</div><div className="bc-s">Let household devices find your rooms on the mesh</div></div><Toggle on={true} onChange={() => {}}/></div>
        <div className="bcast-row locked"><div className="bc-main"><div className="bc-t">Capability actions <span className="wake-lock"><SI name="lock" size={10}/> locked</span></div><div className="bc-s">Real-world actions always broadcast across every transport — non-overridable.</div></div><span className="bc-locked-mark"><SI name="lock" size={13}/></span></div>
        <div className="bcast-row locked"><div className="bc-main"><div className="bc-t">Incoming calls <span className="wake-lock"><SI name="lock" size={10}/> locked</span></div><div className="bc-s">Calls reach you on every available transport so you're never unreachable.</div></div><span className="bc-locked-mark"><SI name="lock" size={13}/></span></div>
      </div>
    </div>
  </>
);

/* ---- Appearance ---- */
const AppearancePanel = ({ theme, onTheme, density, onDensity }) => (
  <>
    <div className="detail-section">
      <div className="label">Theme</div>
      <div className="rx-opts appearance-opts">
        {[{ v: "light", t: "Light", s: "Bright surfaces" }, { v: "dark", t: "Dark", s: "Dim surfaces, same contrast" }].map(o => (
          <label key={o.v} className="rx-opt" data-selected={theme === o.v ? "true" : "false"}>
            <input type="radio" name="theme" checked={theme === o.v} onChange={() => onTheme(o.v)}/>
            <div><div className="t">{o.t}</div><div className="s">{o.s}</div></div>
          </label>
        ))}
      </div>
    </div>
    <div className="detail-section">
      <div className="label">Density</div>
      <div className="rx-opts appearance-opts">
        {[{ v: "comfortable", t: "Comfortable", s: "Roomy spacing and full avatars" }, { v: "compact", t: "Compact", s: "Tighter rows, more on screen" }].map(o => (
          <label key={o.v} className="rx-opt" data-selected={density === o.v ? "true" : "false"}>
            <input type="radio" name="density" checked={density === o.v} onChange={() => onDensity(o.v)}/>
            <div><div className="t">{o.t}</div><div className="s">{o.s}</div></div>
          </label>
        ))}
      </div>
    </div>
  </>
);

/* ============ §B — Recovery-code screen (heavy, unskippable) ============ */
const RecoveryScreen = ({ onDone }) => {
  const [stage, setStage] = React.useState("warn"); /* warn | show | confirm */
  const [checks, setChecks] = React.useState({ written: false, stored: false, understood: false });
  const [revealed, setRevealed] = React.useState(false);
  const allChecked = checks.written && checks.stored && checks.understood;

  return (
    <div className="scrim recovery-scrim">
      <div className="recovery-card" onClick={(e) => e.stopPropagation()}>
        <div className="rec-head">
          <div className="rec-ico"><SI name="key" size={22}/></div>
          <div>
            <h2>Recovery code</h2>
            <div className="rec-sub">24 words · shown once · the only way back in</div>
          </div>
        </div>

        {stage === "warn" && (
          <div className="rec-body">
            <div className="rec-warn">
              <div className="rw-title"><SI name="warning" size={16}/> If you lose this, the identity is gone — by design.</div>
              <p>There is <b>no reset</b>, no account recovery, no support line. These 24 words <b>are</b> the identity. Anyone who reads them can act as Aaron; anyone who loses them cannot get back in.</p>
            </div>
            <ul className="rec-do">
              <li><SI name="check" size={13}/> Write them on paper, in order.</li>
              <li><SI name="check" size={13}/> Store the paper somewhere only you can reach.</li>
              <li><SI name="x" size={13}/> Don't screenshot, email, or type them into anything else.</li>
            </ul>
            <button className="btn primary rec-cta" onClick={() => setStage("show")}>I understand — show the words</button>
          </div>
        )}

        {stage === "show" && (
          <div className="rec-body">
            <div className={"rec-words" + (revealed ? " revealed" : "")}>
              {RECOVERY_WORDS.map((w, i) => (
                <div className="rec-word" key={i}><span className="rw-n">{i + 1}</span><span className="rw-w">{w}</span></div>
              ))}
              {!revealed && (
                <button className="rec-reveal" onClick={() => setRevealed(true)}><SI name="eye" size={16}/> Tap to reveal — make sure no one is watching</button>
              )}
            </div>
            <div className="rec-tools">
              <button className="btn sm ghost"><SI name="print" size={12}/> Print</button>
              <button className="btn sm ghost"><SI name="copy" size={12}/> Copy once</button>
              <span className="grow"/>
              <button className="btn primary sm" disabled={!revealed} onClick={() => setStage("confirm")}>I've saved them →</button>
            </div>
          </div>
        )}

        {stage === "confirm" && (
          <div className="rec-body">
            <div className="rec-confirm-title">Confirm before continuing</div>
            {[
              ["written", "I wrote all 24 words down, in order."],
              ["stored", "I stored them somewhere safe and private."],
              ["understood", "I understand that losing them means losing this identity forever."],
            ].map(([k, label]) => (
              <label key={k} className={"rec-check" + (checks[k] ? " on" : "")}>
                <input type="checkbox" checked={checks[k]} onChange={(e) => setChecks(c => ({ ...c, [k]: e.target.checked }))}/>
                <span className="rc-box"><SI name="check" size={12}/></span>
                <span>{label}</span>
              </label>
            ))}
            <button className="btn primary rec-cta" disabled={!allChecked} onClick={onDone}>Finish — I have my recovery code</button>
            <div className="rec-cannot">This step cannot be skipped.</div>
          </div>
        )}
      </div>
    </div>
  );
};

/* ============ §B — Pair a new device (this device is the new one) ============ */
const PairDeviceScreen = ({ onClose }) => (
  <div className="scrim" onClick={onClose}>
    <div className="modal detail pair-modal" onClick={(e) => e.stopPropagation()}>
      <div className="m-head"><div className="lockup"><div className="icon-wrap settings"><SI name="qr" size={18}/></div><div><h2>Pair this device</h2><div className="sub">Joining as Aaron · no password needed</div></div></div><button className="x" onClick={onClose}><SI name="x" size={16}/></button></div>
      <div className="m-body pair-body">
        <div className="pair-qr"><QRBlock seed="pair-aaron-laptop"/></div>
        <div className="pair-side">
          <div className="pair-step">Scan this from a device already signed in as Aaron.</div>
          <div className="pair-fallback">
            <div className="pf-label">or enter this code</div>
            <div className="pf-code">4 8 2 · 9 1 7</div>
          </div>
          <div className="pair-wait"><span className="pw-spin"/> Waiting for a trusted device to confirm…</div>
          <div className="pair-dev"><SI name="device" size={13}/> This device: <b>Aaron's laptop</b> · <code>7F2A·91C4·DE08</code></div>
        </div>
      </div>
    </div>
  </div>
);

/* ============ §B — Trusted device confirms a new one ============ */
const TrustedConfirmScreen = ({ onClose }) => {
  const [done, setDone] = React.useState(null);
  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal detail" onClick={(e) => e.stopPropagation()} style={{ width: "min(440px,100%)" }}>
        <div className="m-head"><div className="lockup"><div className="icon-wrap settings"><SI name="device" size={18}/></div><div><h2>Confirm new device</h2><div className="sub">A device wants to join your identity</div></div></div><button className="x" onClick={onClose}><SI name="x" size={16}/></button></div>
        <div className="m-body">
          {!done ? (
            <>
              <div className="tc-card">
                <div className="tc-line">A new device wants to join as <b>Aaron</b>.</div>
                <div className="tc-grid">
                  <span className="tc-k">Device</span><span className="tc-v">Aaron's laptop</span>
                  <span className="tc-k">Fingerprint</span><span className="tc-v mono">7F2A·91C4·DE08</span>
                  <span className="tc-k">Requested</span><span className="tc-v">just now · on the LAN</span>
                </div>
                <div className="tc-check"><SI name="info" size={13}/> Only approve if you started this on the other device and the fingerprint matches.</div>
              </div>
              <div className="tc-actions">
                <button className="btn danger" onClick={() => setDone("deny")}>Deny</button>
                <span className="grow"/>
                <button className="btn primary" onClick={() => setDone("approve")}><SI name="check" size={12}/> Approve</button>
              </div>
            </>
          ) : (
            <div className={"tc-result " + done}>
              <SI name={done === "approve" ? "check" : "x"} size={20}/>
              <div>{done === "approve" ? "Approved — the new device is now paired." : "Denied — the request was rejected."}</div>
              <button className="btn sm" onClick={onClose}>Close</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

/* ============ §B — Parent sets up a kid's device ============ */
const ParentSetupScreen = ({ onClose }) => {
  const [step, setStep] = React.useState(0); /* 0 name, 1 recovery handed, 2 QR */
  const [name, setName] = React.useState("");
  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal detail" onClick={(e) => e.stopPropagation()} style={{ width: "min(520px,100%)" }}>
        <div className="m-head"><div className="lockup"><div className="icon-wrap settings"><SI name="person" size={18}/></div><div><h2>Set up a device for someone</h2><div className="sub">Create a new identity in your household</div></div></div><button className="x" onClick={onClose}><SI name="x" size={16}/></button></div>
        <div className="m-body">
          <div className="wiz-steps">
            {["Identity","Recovery","Hand over"].map((s, i) => (
              <div key={s} className={"wiz-step" + (i === step ? " on" : "") + (i < step ? " done" : "")}><span className="ws-n">{i < step ? <SI name="check" size={11}/> : i + 1}</span>{s}</div>
            ))}
          </div>
          {step === 0 && (
            <>
              <div className="field"><label>Their name</label><input type="text" autoFocus value={name} placeholder="e.g. Robin" onChange={(e) => setName(e.target.value)}/></div>
              <div className="claims-note"><SI name="shield" size={12}/> They'll be attested as <b>kind = human</b>, <b>origin = your household</b>. You create their identity and recovery code, then hand over the pairing QR.</div>
              <div className="tc-actions"><span className="grow"/><button className="btn primary" disabled={!name.trim()} onClick={() => setStep(1)}>Next →</button></div>
            </>
          )}
          {step === 1 && (
            <>
              <div className="rec-warn compact"><div className="rw-title"><SI name="warning" size={15}/> Keep {name || "their"}'s recovery code safe.</div><p>You're responsible for the 24-word code until they can hold it themselves. If it's lost, the identity is gone.</p></div>
              <div className="parent-recov"><SI name="key" size={14}/> Recovery code generated · <b>24 words</b> · stored for handoff</div>
              <div className="tc-actions"><button className="btn ghost" onClick={() => setStep(0)}>Back</button><span className="grow"/><button className="btn primary" onClick={() => setStep(2)}>Next →</button></div>
            </>
          )}
          {step === 2 && (
            <>
              <div className="pair-body">
                <div className="pair-qr"><QRBlock seed={"kid-" + (name || "robin")}/></div>
                <div className="pair-side">
                  <div className="pair-step">On {name || "their"}'s device, this looks just like pairing a new device.</div>
                  <div className="pair-fallback"><div className="pf-label">or enter this code</div><div className="pf-code">6 0 5 · 3 3 8</div></div>
                  <div className="pair-wait"><span className="pw-spin"/> Waiting for {name || "their"}'s device…</div>
                </div>
              </div>
              <div className="tc-actions"><button className="btn ghost" onClick={() => setStep(1)}>Back</button><span className="grow"/><button className="btn primary" onClick={onClose}>Done</button></div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

/* ============ §C — Link-radio wizard (Meshtastic) ============ */
const LinkRadioWizard = ({ onClose }) => {
  const [step, setStep] = React.useState(0);
  const [transport, setTransport] = React.useState("usb");
  const [device, setDevice] = React.useState(null);
  const [region, setRegion] = React.useState("US");
  const [writeCfg, setWriteCfg] = React.useState(true);
  const steps = ["Connection", "Select", "Verify", "Confirm"];
  const found = [
    { id: "r1", name: "Heltec V3", detail: "USB · /dev/tty.usbserial-2140" },
    { id: "r2", name: "RAK4631",   detail: "USB · /dev/tty.usbserial-0021" },
  ];
  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal detail" onClick={(e) => e.stopPropagation()} style={{ width: "min(560px,100%)" }}>
        <div className="m-head"><div className="lockup"><div className="icon-wrap settings"><SI name="radio" size={18}/></div><div><h2>Link a radio</h2><div className="sub">Meshtastic · long-range LoRa mesh</div></div></div><button className="x" onClick={onClose}><SI name="x" size={16}/></button></div>
        <div className="m-body">
          <div className="wiz-steps">
            {steps.map((s, i) => (<div key={s} className={"wiz-step" + (i === step ? " on" : "") + (i < step ? " done" : "")}><span className="ws-n">{i < step ? <SI name="check" size={11}/> : i + 1}</span>{s}</div>))}
          </div>

          {step === 0 && (
            <>
              <div className="label sec-label">How is the radio connected?</div>
              <div className="rx-opts">
                {[{ v: "usb", t: "USB / serial", s: "Plugged into this device" }, { v: "ble", t: "Bluetooth", s: "Pair over BLE" }, { v: "mqtt", t: "MQTT gateway", s: "Networked gateway" }].map(o => (
                  <label key={o.v} className="rx-opt" data-selected={transport === o.v ? "true" : "false"}>
                    <input type="radio" name="transport" checked={transport === o.v} onChange={() => setTransport(o.v)}/>
                    <div><div className="t">{o.t}</div><div className="s">{o.s}</div></div>
                  </label>
                ))}
              </div>
              <div className="honesty"><SI name="info" size={13}/> Cairn can't run at the same time as the official Meshtastic app — only one owner per radio.</div>
            </>
          )}
          {step === 1 && (
            <>
              <div className="label sec-label">Select a radio</div>
              <div className="radio-found">
                {found.map(f => (
                  <button key={f.id} className={"rf-row" + (device === f.id ? " on" : "")} onClick={() => setDevice(f.id)}>
                    <SI name="radio" size={15}/>
                    <div className="rf-main"><div className="rf-n">{f.name}</div><div className="rf-d">{f.detail}</div></div>
                    {device === f.id && <SI name="check" size={15}/>}
                  </button>
                ))}
              </div>
              <div className="tc-actions"><button className="btn ghost" onClick={() => setStep(0)}>Back</button><span className="grow"/><button className="btn primary" disabled={!device} onClick={() => setStep(2)}>Next →</button></div>
            </>
          )}
          {step === 2 && (
            <>
              <div className="label sec-label">Verify channel & region</div>
              <div className="scope-grid" style={{ marginBottom: 12 }}>
                <span className="k">Channel</span><span className="v"><code>cairn-home</code> · AES-256</span>
                <span className="k">Region</span>
                <span className="v"><select value={region} onChange={(e) => setRegion(e.target.value)}><option value="US">US (902–928 MHz)</option><option value="EU868">EU 868</option><option value="ANZ">ANZ</option></select></span>
              </div>
              <label className={"cfg-toggle" + (writeCfg ? " on" : "")}>
                <input type="checkbox" checked={writeCfg} onChange={(e) => setWriteCfg(e.target.checked)}/>
                <span className="rc-box"><SI name="check" size={12}/></span>
                <div><div className="t">Write this config to the radio</div><div className="s">Sets the channel and region on the device itself</div></div>
              </label>
              <div className="honesty"><SI name="info" size={13}/> LoRa is slow and duty-cycle limited — great for short messages and alerts, not media.</div>
              <div className="tc-actions"><button className="btn ghost" onClick={() => setStep(1)}>Back</button><span className="grow"/><button className="btn primary" onClick={() => setStep(3)}>Next →</button></div>
            </>
          )}
          {step === 3 && (
            <>
              <div className="link-confirm">
                <div className="lc-ico"><SI name="check" size={22}/></div>
                <div className="lc-t">Radio linked</div>
                <div className="scope-grid lc-grid">
                  <span className="k">Radio</span><span className="v">{found.find(f => f.id === device)?.name || "Heltec V3"}</span>
                  <span className="k">Via</span><span className="v">{transport.toUpperCase()}</span>
                  <span className="k">Channel</span><span className="v"><code>cairn-home</code></span>
                  <span className="k">Region</span><span className="v">{region}</span>
                </div>
              </div>
              <div className="honesty"><SI name="shield" size={13}/> Linking grants no new authority — it's a transport. If the radio is stolen it's a lost peripheral, not your identity.</div>
              <div className="tc-actions"><span className="grow"/><button className="btn primary" onClick={onClose}><SI name="check" size={12}/> Done</button></div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

Object.assign(window, { SettingsModal, RecoveryScreen, PairDeviceScreen, TrustedConfirmScreen, ParentSetupScreen, LinkRadioWizard });
