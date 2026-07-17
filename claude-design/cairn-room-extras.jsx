/* Room extras: Members modal, Settings modal, Kebab menu, Emoji picker, Mention menu */
const { Icon: IR, AgentTag: ATR, CAIRN: CR } = window;
const PR = CR.PEOPLE;

const _useEscR = (onClose) => {
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
};

const _avR = (id, size = 28) => {
  const p = PR[id];
  if (!p) return null;
  if (p.kind === "agent") {
    return <div className="rx-av agent" style={{ width: size, height: size }}>{p.short}</div>;
  }
  return <div className="rx-av" style={{ width: size, height: size, background: p.color }}>{p.initials}</div>;
};

/* ============ Members modal ============ */
const MembersModal = ({ room, onClose, onOpenAudit }) => {
  _useEscR(onClose);
  const [q, setQ] = React.useState("");

  const members = room.members
    .map(id => PR[id])
    .filter(Boolean)
    .filter(m => !q || m.name.toLowerCase().includes(q.toLowerCase()));

  const humans = members.filter(m => m.kind === "human");
  const agents = members.filter(m => m.kind === "agent");

  const roleFor = (m) => {
    if (m.id === "u_me") return "owner";
    if (m.kind === "agent") return "agent";
    if (m.origin) return "guest";
    return "member";
  };
  const presenceFor = (m) => {
    if (m.kind === "agent") return { label: "reachable",    cls: "pos" };
    if (m.id === "u_kai")    return { label: "away · idle",  cls: "warn" };
    if (m.id === "u_sam")    return { label: "via mesh",     cls: "xh"  };
    return { label: "online", cls: "pos" };
  };

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal detail rx-members" onClick={(e) => e.stopPropagation()}>

        <div className="m-head">
          <div className="lockup">
            <div className="icon-wrap members"><IR name="users" size={18}/></div>
            <div>
              <h2>Members of {room.glyph}{room.name}</h2>
              <div className="sub">
                {humans.length} {humans.length === 1 ? "person" : "people"}
                {agents.length > 0 && <><span className="dot"/><span>{agents.length} agent{agents.length > 1 ? "s" : ""}</span></>}
                {room.xh && <><span className="dot"/><span style={{ color: "var(--cross-tint)" }}>cross-household</span></>}
              </div>
            </div>
          </div>
          <button className="x" onClick={onClose}><IR name="x" size={14}/></button>
        </div>

        <div className="m-body" style={{ padding: 0 }}>

          <div className="rx-bar">
            <div className="rx-search">
              <IR name="search" size={14}/>
              <input
                placeholder={`Search members…`}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                autoFocus
              />
            </div>
            <button className="btn primary sm" onClick={() => alert("Invite (modal — wire up later)")}>
              <IR name="plus" size={12}/> Invite
            </button>
          </div>

          {humans.length > 0 && (
            <div className="detail-section">
              <div className="label">People · {humans.length}</div>
              <div className="rx-list">
                {humans.map(m => {
                  const p = presenceFor(m);
                  const role = roleFor(m);
                  return (
                    <div className="rx-row" key={m.id}>
                      <div className="rx-who">
                        {_avR(m.id, 36)}
                        <div className="rx-name">
                          <div className="n">
                            {m.name}
                            {m.id === "u_me" && <span className="rx-you">you</span>}
                            {m.origin && <span className="rx-origin">· {m.origin}</span>}
                          </div>
                          <div className="rx-sub">
                            <span className={"rx-pres " + p.cls}><span className="pip"/>{p.label}</span>
                            <span className="rx-dot"/>
                            <span>@{m.id.replace(/^u_/, "")}</span>
                          </div>
                        </div>
                      </div>
                      <div className={"rx-role " + role}>{role}</div>
                      <div className="rx-actions">
                        <button className="ico-btn" title="Direct message"><IR name="users" size={14}/></button>
                        <button className="ico-btn" title="More"><IR name="kebab" size={14}/></button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {agents.length > 0 && (
            <div className="detail-section">
              <div className="label">Agents · {agents.length}</div>
              <div className="rx-list">
                {agents.map(m => {
                  const p = presenceFor(m);
                  return (
                    <div className="rx-row" key={m.id}>
                      <div className="rx-who">
                        {_avR(m.id, 36)}
                        <div className="rx-name">
                          <div className="n">
                            {m.name}
                            <span className="agt-mini">AGT</span>
                            <span className="rx-origin">· operated by {m.op}</span>
                          </div>
                          <div className="rx-sub">
                            <span className={"rx-pres " + p.cls}><span className="pip"/>{p.label}</span>
                            <span className="rx-dot"/>
                            <span>capabilities: 3 active · 12 dormant</span>
                          </div>
                        </div>
                      </div>
                      <div className="rx-role agent">agent</div>
                      <div className="rx-actions">
                        <button className="ico-btn" title="Open agent panel"><IR name="sliders" size={14}/></button>
                        <button className="ico-btn" title="Audit log" onClick={onOpenAudit}><IR name="logs" size={14}/></button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {members.length === 0 && (
            <div className="detail-section">
              <div style={{ padding: 30, textAlign: "center", color: "var(--text-3)" }}>
                No members match "<b>{q}</b>".
              </div>
            </div>
          )}
        </div>

        <div className="m-foot">
          <span className="grow"/>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
};

/* ============ Room settings modal ============ */
const RoomSettingsModal = ({ room, onClose }) => {
  _useEscR(onClose);

  const [name,    setName]    = React.useState(room.name);
  const [topic,   setTopic]   = React.useState(
    room.kind === "agent-room" ? "Garden agent + ops" :
    room.kind === "dm"         ? "Direct conversation"   :
    room.kind === "xh-group"   ? "Cross-household coordination" : "Group chat"
  );
  const [notify,    setNotify]    = React.useState("mentions");
  const [transport, setTransport] = React.useState(room.transport === "mesh" ? "mesh-pref" : "auto");
  const [whoPosts,  setWhoPosts]  = React.useState("everyone");
  const [retention, setRetention] = React.useState("forever");

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal detail" onClick={(e) => e.stopPropagation()}>

        <div className="m-head">
          <div className="lockup">
            <div className="icon-wrap settings"><IR name="settings" size={18}/></div>
            <div>
              <h2>Room settings</h2>
              <div className="sub">
                <span>{room.glyph}{room.name}</span>
                <span className="dot"/>
                <span>{room.members.length} members</span>
                {room.xh && <><span className="dot"/><span style={{ color: "var(--cross-tint)" }}>cross-household</span></>}
              </div>
            </div>
          </div>
          <button className="x" onClick={onClose}><IR name="x" size={14}/></button>
        </div>

        <div className="m-body">

          <div className="detail-section">
            <div className="label">Identity</div>
            <div className="field">
              <label>Room name</label>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field" style={{ marginTop: 10 }}>
              <label>Topic</label>
              <input type="text" value={topic} onChange={(e) => setTopic(e.target.value)} />
            </div>
          </div>

          <div className="detail-section">
            <div className="label">Notifications</div>
            <div className="rx-opts">
              {[
                { v: "all",       lab: "All messages",      sub: "Every message wakes a notification."           },
                { v: "mentions",  lab: "@mentions only",    sub: "Only when you're tagged or DMed."              },
                { v: "muted",     lab: "Muted",             sub: "No notifications. Badge counts still update." },
              ].map(o => (
                <label key={o.v} className="rx-opt" data-selected={notify === o.v}>
                  <input type="radio" name="notify" checked={notify === o.v} onChange={() => setNotify(o.v)} />
                  <div>
                    <div className="t">{o.lab}</div>
                    <div className="s">{o.sub}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <div className="detail-section">
            <div className="label">Transport preference</div>
            <div className="rx-opts">
              {[
                { v: "auto",       lab: "Auto",            sub: "Use LAN when home, fall back to mesh."     },
                { v: "lan-only",   lab: "LAN only",        sub: "Don't broadcast if LAN is unavailable."     },
                { v: "mesh-pref",  lab: "Mesh-first",      sub: "Prefer the field mesh even when LAN is up." },
              ].map(o => (
                <label key={o.v} className="rx-opt" data-selected={transport === o.v}>
                  <input type="radio" name="transport" checked={transport === o.v} onChange={() => setTransport(o.v)} />
                  <div>
                    <div className="t">{o.lab}</div>
                    <div className="s">{o.sub}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <div className="detail-section">
            <div className="label">Posting permissions</div>
            <div className="scope-grid">
              <div className="k">Who can post</div>
              <div className="v">
                <select value={whoPosts} onChange={(e) => setWhoPosts(e.target.value)}>
                  <option value="everyone">Everyone in the room</option>
                  <option value="owners">Only owners + agents</option>
                  <option value="announce">Announce-only (owners post; others react)</option>
                </select>
              </div>
              <div className="k">Retention</div>
              <div className="v">
                <select value={retention} onChange={(e) => setRetention(e.target.value)}>
                  <option value="forever">Keep forever (local)</option>
                  <option value="90d">Auto-trim after 90 days</option>
                  <option value="30d">Auto-trim after 30 days</option>
                </select>
              </div>
              <div className="k">Cross-household</div>
              <div className="v" style={{ color: room.xh ? "var(--cross-tint)" : "var(--text-3)" }}>
                {room.xh
                  ? "On — outside members are marked, transports honor the receiving household's policy."
                  : "Off — everyone is in this household."}
              </div>
            </div>
          </div>

          <div className="detail-section">
            <div className="label" style={{ color: "var(--neg)" }}>Danger zone</div>
            <div className="rx-danger">
              <div>
                <div className="t">Archive room</div>
                <div className="s">Hide from the sidebar. History stays searchable.</div>
              </div>
              <button className="btn">Archive</button>
            </div>
            <div className="rx-danger">
              <div>
                <div className="t">Leave room</div>
                <div className="s">You'll need to be re-invited to return.</div>
              </div>
              <button className="btn danger">Leave</button>
            </div>
          </div>

        </div>

        <div className="m-foot">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <span className="grow"/>
          <button className="btn primary" onClick={onClose}>
            <IR name="check" size={12}/> Save changes
          </button>
        </div>
      </div>
    </div>
  );
};

/* ============ Kebab popover menu ============ */
const KebabMenu = ({ anchorRect, onClose, items }) => {
  _useEscR(onClose);
  React.useEffect(() => {
    const onClick = (e) => {
      if (!e.target.closest(".rx-pop")) onClose();
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [onClose]);
  if (!anchorRect) return null;
  const top  = anchorRect.bottom + 6;
  const left = Math.max(8, anchorRect.right - 220);
  return (
    <div className="rx-pop kebab-pop" style={{ top, left }}>
      {items.map((it, i) => (
        it.divider
          ? <div className="rx-pop-div" key={i}/>
          : <button
              key={i}
              className={"rx-pop-item" + (it.danger ? " danger" : "")}
              onClick={() => { it.onClick?.(); onClose(); }}
            >
              {it.icon && <IR name={it.icon} size={13}/>}
              <span>{it.label}</span>
              {it.hint && <span className="hint">{it.hint}</span>}
            </button>
      ))}
    </div>
  );
};

/* ============ Emoji picker popover ============ */
const EMOJI_GROUPS = [
  { name: "Recent",  items: ["👍","❤️","😂","🎉","🙏","🔥","✅","🌀","🪴","🌧️"] },
  { name: "Smileys", items: ["😀","😄","😅","😂","🤣","🙂","😉","😊","🥲","😍","😘","🤩","🤔","😴","😎","🥳","😬","🙄","😅","😭"] },
  { name: "People",  items: ["👋","🤝","👏","🙏","💪","🫶","👀","🧠","🫡","🫠","🧑‍🌾","🧑‍🍳","🧑‍💻","🧑‍🔧","🧑‍🚀"] },
  { name: "Nature",  items: ["🌱","🪴","🌿","🍃","🌳","🌲","🌸","🌼","🌻","🌧️","🌦️","⛅","☀️","🌙","⭐","❄️","🌊"] },
  { name: "Objects", items: ["💡","🔧","🔩","🔋","📦","🗝️","🧰","⚙️","📟","🛠️","📡","🧪","🔬","🛡️","🔒","🔓","🪙"] },
  { name: "Symbols", items: ["✅","❌","⚠️","❗","❓","🔁","➡️","⬅️","⬆️","⬇️","🔼","🔽","♻️","💯","✨","🆗"] },
];
const EmojiPicker = ({ anchorRect, onPick, onClose }) => {
  _useEscR(onClose);
  React.useEffect(() => {
    const onClick = (e) => { if (!e.target.closest(".rx-pop")) onClose(); };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [onClose]);
  const [q, setQ] = React.useState("");
  const [activeGroup, setActiveGroup] = React.useState("Recent");

  if (!anchorRect) return null;
  const width = 320;
  const height = 320;
  let top = anchorRect.top - height - 8;
  if (top < 8) top = anchorRect.bottom + 8; /* flip below if no room above */
  if (top + height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - height - 8);
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, anchorRect.left - 8));

  const filtered = q
    ? EMOJI_GROUPS.flatMap(g => g.items).filter(() => true) // no metadata; show all under "search"
    : (EMOJI_GROUPS.find(g => g.name === activeGroup)?.items ?? []);

  return (
    <div className="rx-pop emoji-pop" style={{ top, left, width, height }}>
      <div className="emoji-search">
        <IR name="search" size={13}/>
        <input
          placeholder="Search emoji…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />
      </div>
      <div className="emoji-grid">
        {filtered.map((e, i) => (
          <button key={i} className="emoji-btn" onClick={() => onPick(e)}>{e}</button>
        ))}
      </div>
      <div className="emoji-tabs">
        {EMOJI_GROUPS.map(g => (
          <button
            key={g.name}
            className="emoji-tab"
            aria-pressed={!q && activeGroup === g.name}
            onClick={() => { setQ(""); setActiveGroup(g.name); }}
            title={g.name}
          >
            {g.items[0]}
          </button>
        ))}
      </div>
    </div>
  );
};

/* ============ Mention menu popover ============ */
const MentionMenu = ({ anchorRect, room, onPick, onClose }) => {
  _useEscR(onClose);
  React.useEffect(() => {
    const onClick = (e) => { if (!e.target.closest(".rx-pop")) onClose(); };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [onClose]);
  const [q, setQ] = React.useState("");
  const [sel, setSel] = React.useState(0);

  if (!anchorRect) return null;
  const width = 280;
  const top  = anchorRect.top - 8;
  const left = Math.max(8, anchorRect.left);

  const members = room.members
    .map(id => PR[id])
    .filter(Boolean)
    .filter(m => !q || m.name.toLowerCase().includes(q.toLowerCase()));

  const groups = [
    { id: "everyone",  name: "everyone",      sub: `Notify all ${room.members.length} members`,         kind: "group" },
    { id: "humans",    name: "people",        sub: "Notify only the humans in this room",              kind: "group" },
  ];

  const handlePick = (item) => {
    onPick(item);
  };

  React.useEffect(() => {
    const onKey = (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); setSel(s => Math.min(s + 1, members.length + groups.length - 1)); }
      if (e.key === "ArrowUp")   { e.preventDefault(); setSel(s => Math.max(s - 1, 0)); }
      if (e.key === "Enter") {
        e.preventDefault();
        const all = [...groups, ...members];
        const item = all[sel];
        if (item) handlePick(item.kind === "group" ? { mention: "@" + item.name } : { mention: "@" + item.name.toLowerCase().replace(/\s+/g, "") });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sel, members.length]);

  return (
    <div className="rx-pop mention-pop" style={{ top, left, width, transform: "translateY(-100%)" }}>
      <div className="emoji-search" style={{ borderRadius: "var(--r-3) var(--r-3) 0 0" }}>
        <IR name="search" size={13}/>
        <input
          placeholder="Mention someone…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />
      </div>
      <div className="mention-list">
        {!q && (
          <>
            <div className="mention-section">Groups</div>
            {groups.map((g, i) => (
              <div
                key={g.id}
                className="mention-row"
                aria-selected={sel === i}
                onMouseEnter={() => setSel(i)}
                onClick={() => handlePick({ mention: "@" + g.name })}
              >
                <div className="rx-av group" style={{ width: 28, height: 28 }}>
                  <IR name="users" size={14}/>
                </div>
                <div className="rx-name">
                  <div className="n">@{g.name}</div>
                  <div className="rx-sub">{g.sub}</div>
                </div>
              </div>
            ))}
            <div className="mention-section">Members · {members.length}</div>
          </>
        )}
        {members.map((m, i) => {
          const idx = !q ? groups.length + i : i;
          return (
            <div
              key={m.id}
              className="mention-row"
              aria-selected={sel === idx}
              onMouseEnter={() => setSel(idx)}
              onClick={() => handlePick({ mention: "@" + m.name.toLowerCase().replace(/\s+/g, "") })}
            >
              {_avR(m.id, 28)}
              <div className="rx-name">
                <div className="n">
                  {m.name}
                  {m.kind === "agent" && <span className="agt-mini">AGT</span>}
                  {m.id === "u_me" && <span className="rx-you">you</span>}
                </div>
                <div className="rx-sub">
                  {m.kind === "agent" ? `agent · op. ${m.op}` : (m.origin ?? "this household")}
                </div>
              </div>
            </div>
          );
        })}
        {members.length === 0 && (
          <div style={{ padding: 18, textAlign: "center", color: "var(--text-3)", fontSize: 12 }}>
            No matches.
          </div>
        )}
      </div>
    </div>
  );
};

Object.assign(window, { MembersModal, RoomSettingsModal, KebabMenu, EmojiPicker, MentionMenu });
