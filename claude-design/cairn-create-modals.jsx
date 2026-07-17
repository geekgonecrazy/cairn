/* Create-Space and Create-Channel modals */
const { Icon: CIcon, CAIRN: CCAIRN } = window;
const { PEOPLE: CC_PEOPLE } = CCAIRN;

const _ccSlug = (s) =>
  s.toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);

const _ccDeriveShort = (name) => {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.trim().slice(0, 2).toUpperCase();
};

const _useCCEsc = (onClose) => {
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
};

/* ============ CreateSpaceModal ============ */
const CreateSpaceModal = ({ onClose, onSubmit, existingShorts = [] }) => {
  _useCCEsc(onClose);
  const [name, setName] = React.useState("");
  const [shortInput, setShortInput] = React.useState("");
  const [shortTouched, setShortTouched] = React.useState(false);
  const [desc, setDesc] = React.useState("");
  const [reach, setReach] = React.useState("household");

  const autoShort = _ccDeriveShort(name);
  const short = (shortTouched ? shortInput : autoShort).toUpperCase().slice(0, 2);
  const conflict = short.length === 2 && existingShorts.includes(short);
  const valid = name.trim().length >= 2 && short.length === 2 && !conflict;

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal cc-modal" onClick={(e) => e.stopPropagation()}>
        <div className="m-head">
          <h2>Create a space</h2>
          <span className="meta">scope · routing</span>
          <button className="x" onClick={onClose}><CIcon name="x" size={14}/></button>
        </div>

        <div className="m-body">
          <div className="cc-preview-row">
            <div className="cc-space-tile" data-empty={short.length < 2 ? "true" : "false"}>
              {short || "··"}
            </div>
            <div className="cc-preview-text">
              <div className="cc-preview-title">{name.trim() || <span style={{ color: "var(--text-4)" }}>Untitled space</span>}</div>
              <div className="cc-preview-sub">
                {reach === "cross"
                  ? <><span className="cc-xh-dot"/> Cross-household · routes via mesh</>
                  : <>Household-local · LAN only</>
                }
              </div>
            </div>
          </div>

          <div className="field">
            <label>Space name</label>
            <input
              type="text"
              autoFocus
              placeholder="e.g. Studio, Cabin, Co-op"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={32}
            />
          </div>

          <div className="field">
            <label>Short code <span className="cc-hint">2 letters · used in the space rail</span></label>
            <input
              type="text"
              className="cc-short-input"
              value={short}
              onChange={(e) => {
                setShortTouched(true);
                setShortInput(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 2));
              }}
              maxLength={2}
              placeholder="AB"
            />
            {conflict && <span className="cc-err">{short} is already in use</span>}
          </div>

          <div className="field">
            <label>Routing</label>
            <div className="cc-radio-stack">
              <label className="rx-opt" data-selected={reach === "household" ? "true" : "false"} onClick={() => setReach("household")}>
                <input type="radio" name="cc-reach" checked={reach === "household"} onChange={() => setReach("household")}/>
                <div>
                  <div className="t">Household-local</div>
                  <div className="s">Stays on your home network. Members must be in your household.</div>
                </div>
              </label>
              <label className="rx-opt" data-selected={reach === "cross" ? "true" : "false"} onClick={() => setReach("cross")}>
                <input type="radio" name="cc-reach" checked={reach === "cross"} onChange={() => setReach("cross")}/>
                <div>
                  <div className="t">Cross-household</div>
                  <div className="s">Invite from other households. Routes via mesh when LAN isn't shared.</div>
                </div>
              </label>
            </div>
          </div>

          <div className="field">
            <label>Description <span className="cc-hint">optional</span></label>
            <textarea
              placeholder="What this space is for…"
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              style={{ minHeight: 60 }}
              maxLength={140}
            />
          </div>
        </div>

        <div className="m-foot">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <span className="grow"/>
          <button
            className="btn primary"
            disabled={!valid}
            onClick={() => onSubmit({
              name: name.trim(),
              short,
              desc: desc.trim(),
              reach,
            })}
          >
            <CIcon name="plus" size={12}/> Create space
          </button>
        </div>
      </div>
    </div>
  );
};

/* ============ CreateChannelModal ============ */
const CreateChannelModal = ({ defaultSpaceId, spaces, onClose, onSubmit, existingNames = [] }) => {
  _useCCEsc(onClose);
  const [name, setName] = React.useState("");
  const [desc, setDesc] = React.useState("");
  const [type, setType] = React.useState("open"); /* open | private */
  const [spaceId, setSpaceId] = React.useState(defaultSpaceId || spaces[0]?.id);
  const [xh, setXh] = React.useState(false);
  const [members, setMembers] = React.useState(() => new Set());
  const [agentIds, setAgentIds] = React.useState(() => new Set());
  const [memberQuery, setMemberQuery] = React.useState("");

  const slug = _ccSlug(name);
  const glyph = type === "private" ? "🔒" : "#";
  const conflictName = slug && existingNames.includes(slug);
  const valid = slug.length >= 2 && !conflictName;

  const humans = Object.values(CC_PEOPLE).filter(p => p.kind === "human" && p.id !== "u_me");
  const agents = Object.values(CC_PEOPLE).filter(p => p.kind === "agent");

  const filteredHumans = memberQuery.trim()
    ? humans.filter(p => p.name.toLowerCase().includes(memberQuery.toLowerCase()))
    : humans;

  const toggleMember = (id) => {
    setMembers(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAgent = (id) => {
    setAgentIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const totalMembers = members.size + agentIds.size + 1; /* +1 for me */

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal cc-modal cc-modal-channel" onClick={(e) => e.stopPropagation()}>
        <div className="m-head">
          <h2>Create a channel</h2>
          <span className="meta">in {spaces.find(s => s.id === spaceId)?.name || "—"}</span>
          <button className="x" onClick={onClose}><CIcon name="x" size={14}/></button>
        </div>

        <div className="m-body">
          <div className="field">
            <label>Channel name</label>
            <div className="cc-name-row">
              <span className="cc-name-glyph" aria-hidden="true">{glyph}</span>
              <input
                type="text"
                autoFocus
                placeholder="shopping-list"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={32}
              />
            </div>
            {(slug || conflictName) && (
              <div className="cc-preview-line">
                {slug && <span>Will appear as <code>{glyph}{slug}</code></span>}
                {conflictName && <span className="cc-err">· name already in use</span>}
              </div>
            )}
            <div className="cc-hint cc-hint-block">Lowercase letters, numbers and hyphens. Spaces become hyphens.</div>
          </div>

          <div className="field">
            <label>Type</label>
            <div className="seg" role="radiogroup">
              <button aria-pressed={type === "open" ? "true" : "false"} onClick={() => setType("open")}>
                <span style={{ fontFamily: "var(--font-mono)", marginRight: 4 }}>#</span> Open
              </button>
              <button aria-pressed={type === "private" ? "true" : "false"} onClick={() => setType("private")}>
                <CIcon name="lock" size={11}/> Private
              </button>
            </div>
            <div className="cc-hint cc-hint-block">
              {type === "open"
                ? "Anyone in the space can find and join this channel."
                : "Only invited members can see and join. Doesn't appear in browse."}
            </div>
          </div>

          <div className="field">
            <label>Space</label>
            <select value={spaceId} onChange={(e) => setSpaceId(e.target.value)}>
              {spaces.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>

          <div className="field">
            <label>People <span className="cc-hint">{members.size + 1} selected</span></label>
            <div className="cc-member-picker">
              <div className="cc-mp-search">
                <CIcon name="search" size={12}/>
                <input
                  type="text"
                  placeholder="Filter by name…"
                  value={memberQuery}
                  onChange={(e) => setMemberQuery(e.target.value)}
                />
              </div>
              <div className="cc-mp-grid">
                <div className="cc-chip me-chip" title="You are always a member">
                  <span className="cc-mp-av" style={{ background: "var(--accent)" }}>AR</span>
                  <span>You</span>
                  <span className="cc-chip-locked">owner</span>
                </div>
                {filteredHumans.map(p => {
                  const sel = members.has(p.id);
                  return (
                    <button
                      type="button"
                      key={p.id}
                      className={"cc-chip" + (sel ? " selected" : "")}
                      onClick={() => toggleMember(p.id)}
                    >
                      <span className="cc-mp-av" style={{ background: p.color }}>{p.initials}</span>
                      <span>{p.name}</span>
                      {p.origin && <span className="cc-chip-origin" title={p.origin}>· xh</span>}
                      {sel
                        ? <CIcon name="check" size={11}/>
                        : <CIcon name="plus" size={11}/>
                      }
                    </button>
                  );
                })}
                {filteredHumans.length === 0 && (
                  <span className="cc-mp-empty">No people match "{memberQuery}"</span>
                )}
              </div>
            </div>
          </div>

          <div className="field">
            <label>Agents <span className="cc-hint">optional · multiple allowed</span></label>
            <div className="cc-mp-grid">
              {agents.map(a => {
                const sel = agentIds.has(a.id);
                return (
                  <button
                    type="button"
                    key={a.id}
                    className={"cc-chip" + (sel ? " selected" : "")}
                    onClick={() => toggleAgent(a.id)}
                  >
                    <span className="cc-mp-av agent">{a.short}</span>
                    <span>{a.name}</span>
                    <span className="cc-mp-agt">AGT</span>
                    {sel
                      ? <CIcon name="check" size={11}/>
                      : <CIcon name="plus" size={11}/>
                    }
                  </button>
                );
              })}
            </div>
          </div>

          <button
            type="button"
            className={"cc-toggle-card" + (xh ? " on" : "")}
            onClick={() => setXh(!xh)}
            aria-pressed={xh ? "true" : "false"}
          >
            <div className="cc-toggle-switch" data-on={xh ? "true" : "false"}>
              <div className="cc-toggle-knob"/>
            </div>
            <div className="cc-toggle-body">
              <div className="cc-toggle-t">Cross-household channel</div>
              <div className="cc-toggle-s">
                Allows participants from other households. Chrome gets the amber tint and messages route via mesh when the LAN isn't shared.
              </div>
            </div>
          </button>

          <div className="field">
            <label>Description <span className="cc-hint">optional</span></label>
            <textarea
              placeholder="What is this channel for?"
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              style={{ minHeight: 56 }}
              maxLength={160}
            />
          </div>
        </div>

        <div className="m-foot">
          <span className="cc-foot-meta">
            <CIcon name="users" size={12}/>
            {totalMembers} member{totalMembers !== 1 ? "s" : ""}
          </span>
          <span className="grow"/>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={!valid}
            onClick={() => onSubmit({
              name: slug,
              glyph,
              private: type === "private",
              spaceId,
              desc: desc.trim(),
              xh,
              members: ["u_me", ...Array.from(members), ...Array.from(agentIds)],
              agentIds: Array.from(agentIds),
            })}
          >
            <CIcon name="plus" size={12}/> Create channel
          </button>
        </div>
      </div>
    </div>
  );
};

Object.assign(window, { CreateSpaceModal, CreateChannelModal });
