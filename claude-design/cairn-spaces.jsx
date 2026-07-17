/* §D — Space settings (admit-policy) + peer-household join flow.
   Spaces are framed as CONFIGURED POLICY, not built-in types. The join flow is the
   deliberate, friction-ful act of admitting someone from another household on the stack. */
const { Icon: SPI } = window;

/* reuse the QR component from settings */
const SPQR = (props) => React.createElement(window.QRBlock || (() => null), props);

/* ============ Space settings ============ */
const SpaceSettingsModal = ({ space, roomCount, onClose, onOpenJoin }) => {
  const [allowAgents, setAllowAgents] = React.useState(space?.reach !== "closed");
  const [origin, setOrigin] = React.useState(space?.admitOrigin || "own");
  const [peers, setPeers] = React.useState(space?.peerRoots || ["sister's household"]);

  React.useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const Sw = ({ on, onChange, tone }) => (
    <button className={"sw" + (on ? " on" : "")} data-tone={tone} role="switch" aria-checked={on} onClick={() => onChange(!on)}><span className="sw-knob"/></button>
  );

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal detail space-settings" onClick={(e) => e.stopPropagation()}>
        <div className="m-head">
          <div className="lockup">
            <div className="icon-wrap settings"><SPI name="settings" size={18}/></div>
            <div>
              <h2>{space?.name} · Space settings</h2>
              <div className="sub">{roomCount} room{roomCount !== 1 ? "s" : ""}<span className="dot"/>policy, not a fixed type</div>
            </div>
          </div>
          <button className="x" onClick={onClose}><SPI name="x" size={16}/></button>
        </div>
        <div className="m-body">
          <div className="detail-section">
            <div className="label">What a Space is</div>
            <div className="claims-note" style={{ marginTop: 0 }}>
              <SPI name="info" size={12}/>
              A Space is a <b>set of admit rules</b> applied to its rooms — who and what can join. “Family” and “Ops” are just examples of policy, not special built-in kinds.
            </div>
          </div>

          <div className="detail-section">
            <div className="label">Agents (kind)</div>
            <div className="notif-row" style={{ padding: "4px 0" }}>
              <div className="nr-main">
                <div className="nr-t">Allow agents in this Space's rooms</div>
                <div className="nr-s">When off, only <b>human</b>-kind identities may join rooms here — no agents, in your household or any peer's.</div>
              </div>
              <Sw on={allowAgents} onChange={setAllowAgents}/>
            </div>
          </div>

          <div className="detail-section">
            <div className="label">Origin — who may be admitted</div>
            <div className="rx-opts">
              {[
                { v: "own",   t: "Own household only", s: "The default. Nobody outside your root of trust." },
                { v: "any",   t: "Any peer household", s: "Anyone running the stack can be admitted after review." },
                { v: "roots", t: "Specific peer roots…", s: "Only the households you name below." },
              ].map(o => (
                <label key={o.v} className="rx-opt" data-selected={origin === o.v ? "true" : "false"}>
                  <input type="radio" name="origin" checked={origin === o.v} onChange={() => setOrigin(o.v)}/>
                  <div><div className="t">{o.t}</div><div className="s">{o.s}</div></div>
                </label>
              ))}
            </div>
            {origin === "roots" && (
              <div className="peer-roots">
                {peers.map((p, i) => (
                  <span key={i} className="peer-chip"><SPI name="house" size={11}/>{p}<button onClick={() => setPeers(ps => ps.filter((_, j) => j !== i))}><SPI name="x" size={10}/></button></span>
                ))}
                <button className="peer-add" onClick={() => onOpenJoin?.()}><SPI name="plus" size={11}/> Add a peer root</button>
              </div>
            )}
          </div>

          <div className="detail-section">
            <div className="label">Cross-household</div>
            <div className="join-tile">
              <div className="jt-ico"><SPI name="link" size={16}/></div>
              <div className="jt-body">
                <div className="jt-t">Admit someone from another household</div>
                <div className="jt-s">A deliberate, reviewed handshake with another household running the stack. You'll see their origin before you confirm.</div>
              </div>
              <button className="btn sm" disabled={origin === "own"} onClick={onOpenJoin} title={origin === "own" ? "Set origin to allow peers first" : undefined}>Start join</button>
            </div>
            {origin === "own" && <div className="claims-note"><SPI name="info" size={12}/> Set origin to “any peer” or “specific roots” to admit outside households.</div>}
          </div>
        </div>
        <div className="m-foot">
          <span className="grow"/>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={onClose}>Save policy</button>
        </div>
      </div>
    </div>
  );
};

/* ============ Peer-household join flow ============ */
const PEER_IDENTITY = {
  name: "Sam", origin: "Rivera household", kind: "human",
  fp: "C41E·88B0·2D7A·9F13", root: "rvra.root", first: "3 shared rooms with your household",
};

const PeerJoinModal = ({ onClose, onAdmit }) => {
  const [tab, setTab] = React.useState("pubkey");
  const [stage, setStage] = React.useState("intake"); /* intake | review | done */
  const [pubkey, setPubkey] = React.useState("");

  React.useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const canProceed = tab === "pubkey" ? pubkey.trim().length > 8 : true;

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal detail peer-join" onClick={(e) => e.stopPropagation()}>
        <div className="m-head">
          <div className="lockup">
            <div className="icon-wrap" style={{ background: "color-mix(in oklab, var(--cross-tint) 14%, transparent)", color: "var(--cross-tint)" }}><SPI name="link" size={18}/></div>
            <div>
              <h2>Admit a peer household</h2>
              <div className="sub">Cross-household<span className="dot"/>reviewed by you</div>
            </div>
          </div>
          <button className="x" onClick={onClose}><SPI name="x" size={16}/></button>
        </div>

        <div className="m-body">
          {stage === "intake" && (
            <>
              <div className="pj-tabs">
                {[{ v: "pubkey", t: "Paste pubkey", i: "key" }, { v: "qr", t: "Scan QR", i: "qr" }, { v: "invite", t: "Signed invite", i: "file" }].map(o => (
                  <button key={o.v} className={"pj-tab" + (tab === o.v ? " on" : "")} onClick={() => setTab(o.v)}><SPI name={o.i} size={13}/> {o.t}</button>
                ))}
              </div>

              {tab === "pubkey" && (
                <div className="field">
                  <label>Their public key</label>
                  <textarea placeholder="cairn:pk:ed25519:…  paste the full key they sent you" value={pubkey} onChange={(e) => setPubkey(e.target.value)} style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, minHeight: 84 }}/>
                  <div className="claims-note" style={{ marginTop: 8 }}><SPI name="info" size={12}/> No SMS, email, or Signal bridge — this only admits other households running the Cairn stack.</div>
                </div>
              )}
              {tab === "qr" && (
                <div className="pj-scan">
                  <div className="pj-scanframe"><SPQR seed="peer-rivera" size={150}/><div className="pj-scan-line"/></div>
                  <div className="pj-scan-txt">Point their device's identity QR at your camera, or have them scan yours.</div>
                </div>
              )}
              {tab === "invite" && (
                <div className="pj-invite">
                  <div className="pj-file"><SPI name="file" size={20}/><div><div className="pj-file-n">rivera-invite.cairn-sig</div><div className="pj-file-d">signed invite · verified signature</div></div><SPI name="check" size={16}/></div>
                  <div className="claims-note"><SPI name="shield" size={12}/> The signature checks out against the Rivera root. You still choose whether to admit them.</div>
                </div>
              )}

              <div className="tc-actions">
                <span className="grow"/>
                <button className="btn primary" disabled={!canProceed} onClick={() => setStage("review")}>Review identity →</button>
              </div>
            </>
          )}

          {stage === "review" && (
            <>
              <div className="pj-review">
                <div className="pj-rev-head">
                  <div className="pj-rev-av">SM</div>
                  <div>
                    <div className="pj-rev-name">{PEER_IDENTITY.name}</div>
                    <div className="pj-rev-kind"><span className="kind-chip"><SPI name="person" size={10}/> kind: {PEER_IDENTITY.kind}</span></div>
                  </div>
                </div>
                <div className="pj-rev-grid">
                  <span className="tc-k">Origin</span><span className="tc-v xh"><SPI name="house" size={12}/> {PEER_IDENTITY.origin}</span>
                  <span className="tc-k">Root fingerprint</span><span className="tc-v mono">{PEER_IDENTITY.fp}</span>
                  <span className="tc-k">Root id</span><span className="tc-v mono">{PEER_IDENTITY.root}</span>
                  <span className="tc-k">Context</span><span className="tc-v">{PEER_IDENTITY.first}</span>
                </div>
                <div className="pj-warn">
                  <SPI name="info" size={13}/>
                  Admitting <b>{PEER_IDENTITY.name}</b> flips this room to <b>cross-household</b>. They'll be labelled with their origin everywhere, and the room gets the amber cross-household chrome.
                </div>
              </div>
              <div className="tc-actions">
                <button className="btn ghost" onClick={() => setStage("intake")}>Back</button>
                <span className="grow"/>
                <button className="btn primary" onClick={() => { onAdmit?.(PEER_IDENTITY); setStage("done"); }}><SPI name="check" size={12}/> Confirm & admit</button>
              </div>
            </>
          )}

          {stage === "done" && (
            <div className="tc-result approve" style={{ paddingBottom: 8 }}>
              <SPI name="check" size={20}/>
              <div><b>{PEER_IDENTITY.name}</b> was admitted from the {PEER_IDENTITY.origin}. This room is now cross-household.</div>
              <button className="btn sm primary" onClick={onClose}>Go to the room</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

Object.assign(window, { SpaceSettingsModal, PeerJoinModal });
