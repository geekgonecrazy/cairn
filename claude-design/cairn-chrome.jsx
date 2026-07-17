/* Chrome: SpaceRail, RoomList, RoomHeader, MessageList, Composer */
const { Icon, CAIRN } = window;
const { PEOPLE, SPACES } = CAIRN;

/* ---- agent badge — option 4: name + small mono AGT pill, with optional "operated by" line ---- */
const AgentTag = ({ id, showOp = true, size = "md" }) => {
  const a = PEOPLE[id];
  if (!a) return null;
  return (
    <span className="agent-tag">
      <span>{a.name}</span>
      <span className="pill" title={`Agent · operated by ${a.op}`}>AGT</span>
      {showOp && <span className="op">· op. {a.op}</span>}
    </span>
  );
};

/* ---- Space rail (left) ---- */
const SpaceRail = ({ spaces, active, onPick, mobile, onSwitchView, onCreateSpace }) => (
  <aside className="space-rail">
    <div className="logo" title="Cairn">
      <svg width="26" height="26" viewBox="0 0 26 26" fill="none">
        {/* stacked stones — cairn mark */}
        <rect x="6"  y="14.5" width="14" height="4"  rx="1.2" fill="var(--text)"/>
        <rect x="8"  y="9.5"  width="10" height="3.5" rx="1"  fill="var(--text-2)"/>
        <rect x="10" y="5.5"  width="6"  height="3"   rx="0.8" fill="var(--accent)"/>
        <rect x="4"  y="20"   width="18" height="1.4" rx="0.6" fill="var(--border-2)"/>
      </svg>
    </div>
    {spaces.map(s => (
      <button
        key={s.id}
        className="space"
        aria-current={active === s.id ? "true" : "false"}
        title={s.name}
        onClick={() => { onPick(s.id); if (mobile) onSwitchView?.("rooms"); }}
      >
        {s.short}
        {s.hasUnread && active !== s.id && <span className="dot"/>}
      </button>
    ))}
    <div className="grow"/>
    <button className="space add-space" title="Create space" onClick={onCreateSpace}>
      <Icon name="plus"/>
    </button>
    <button className="me" title="Aaron · this device">AR</button>
  </aside>
);

/* ---- Room list (left middle) ---- */
const RoomList = ({ space, spaces, rooms, activeRoom, onPick, mobile, onSwitchView, transportMode, setTransportMode, onCreateChannel }) => {
  const spaceMeta = spaces.find(s => s.id === space);
  const inSpace = rooms.filter(r => r.space === space);
  const channels = inSpace.filter(r => r.kind !== "dm");
  const dms      = inSpace.filter(r => r.kind === "dm");

  const renderItem = (r) => {
    const hasAgent = r.members.some(m => PEOPLE[m]?.kind === "agent");
    return (
      <li
        key={r.id}
        className="room-item"
        aria-current={activeRoom === r.id ? "true" : "false"}
        onClick={() => { onPick(r.id); if (mobile) onSwitchView?.("room"); }}
      >
        <span className="glyph">{r.glyph}</span>
        <span className="name">
          {r.name}
          {r.xh && <span className="xh-dot" title="Cross-household"/>}
          {hasAgent && <span className="agent-dot" title="Includes an agent"/>}
        </span>
        {r.unread > 0 && (
          <span className={"badge" + (r.kind === "dm" ? " accent" : "")}>{r.unread}</span>
        )}
      </li>
    );
  };

  return (
    <nav className="room-list">
      <div className="head">
        <h2>{spaceMeta?.name}</h2>
        <div className="head-actions">
          <span className="meta">{inSpace.length} rooms</span>
          <button
            className="add-channel"
            title={`Create channel in ${spaceMeta?.name}`}
            onClick={() => onCreateChannel?.(space)}
          >
            <Icon name="plus" size={12}/>
          </button>
        </div>
      </div>
      <div className="search">
        <Icon name="search"/>
        <input placeholder={`Search ${spaceMeta?.name.toLowerCase()}…`} />
      </div>

      <div className="rooms">
        {channels.length > 0 ? (
          <>
            <div className="section-label">
              <span>
                Channels
                <button
                  className="lbl-add"
                  title="Create channel"
                  onClick={(e) => { e.stopPropagation(); onCreateChannel?.(space); }}
                >
                  <Icon name="plus" size={11}/>
                </button>
              </span>
              <span className="count">{channels.length}</span>
            </div>
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {channels.map(renderItem)}
            </ul>
          </>
        ) : (
          <button
            className="empty-create"
            onClick={() => onCreateChannel?.(space)}
            style={{
              margin: "12px 8px",
              padding: "14px 12px",
              width: "calc(100% - 16px)",
              border: "1px dashed var(--border-2)",
              borderRadius: "var(--r-3)",
              background: "transparent",
              color: "var(--text-3)",
              cursor: "pointer",
              fontSize: 12.5,
              fontFamily: "inherit",
              display: "flex",
              alignItems: "center",
              gap: 8,
              justifyContent: "center",
            }}
          >
            <Icon name="plus" size={12}/>
            Create the first channel
          </button>
        )}
        {dms.length > 0 && (
          <>
            <div className="section-label">
              <span>Direct</span>
              <span className="count">{dms.length}</span>
            </div>
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {dms.map(renderItem)}
            </ul>
          </>
        )}
      </div>

      <div className="footer">
        <span className="status-dot" title="Online"/>
        <span>Aaron · this device</span>
        <button
          className="mode"
          onClick={() => {
            const order = ["AUTO", "HOME", "FIELD", "MESH-ONLY"];
            setTransportMode(order[(order.indexOf(transportMode) + 1) % order.length]);
          }}
          title="Cycle transport mode"
        >
          {transportMode}
        </button>
      </div>
    </nav>
  );
};

/* ---- Room header ---- */
const RoomHeader = ({ room, onBack, onStartCall, onOpenMembers, onOpenSettings, onMute, onPin, onMarkRead, onArchive, onLeave, onOpenAudit, sidebarVisible, onToggleSidebar, hasSidebar }) => {
  const memberSummary = room.members
    .map(id => PEOPLE[id])
    .filter(Boolean);
  const humans = memberSummary.filter(m => m.kind === "human").length;
  const agents = memberSummary.filter(m => m.kind === "agent").length;

  const [kebabRect, setKebabRect] = React.useState(null);
  const kebabRef = React.useRef(null);

  return (
    <header className="room-header">
      <button className="back" onClick={onBack}><Icon name="back"/></button>
      <div className="title">
        <h1>
          <span className="room-glyph">{room.glyph}</span>
          {room.name}
        </h1>
        <div className="sub">
          <span>{humans} {humans === 1 ? "person" : "people"}</span>
          {agents > 0 && <><span className="dot"/><span>{agents} agent{agents > 1 ? "s" : ""}</span></>}
          {room.xh && <><span className="dot"/><span style={{ color: "var(--cross-tint)" }}>cross-household</span></>}
          <span className="dot"/>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <Icon name={room.transport === "mesh" ? "mesh" : "house"} size={12}/>
            via {room.transport === "mesh" ? "mesh" : "LAN"}
          </span>
        </div>
      </div>
      <div className="actions">
        <button className="icon-btn" title="Start call" onClick={onStartCall}><Icon name="phone"/></button>
        <button className="icon-btn" title="Members" onClick={onOpenMembers}><Icon name="users"/></button>
        <button className="icon-btn" title="Room settings" onClick={onOpenSettings}><Icon name="sliders"/></button>
        {hasSidebar && (
          <button
            className="icon-btn"
            data-toggle={sidebarVisible ? "on" : "off"}
            title={sidebarVisible ? "Hide side panel" : "Show side panel"}
            onClick={onToggleSidebar}
          >
            <Icon name="settings"/>
          </button>
        )}
        <button
          ref={kebabRef}
          className="icon-btn"
          title="More"
          onClick={() => {
            const r = kebabRef.current?.getBoundingClientRect();
            setKebabRect(r ? { top: r.top, bottom: r.bottom, left: r.left, right: r.right } : null);
          }}
        >
          <Icon name="kebab"/>
        </button>
      </div>
      {kebabRect && (
        <window.KebabMenu
          anchorRect={kebabRect}
          onClose={() => setKebabRect(null)}
          items={[
            { icon: "search",   label: "Search in room",  hint: "⌘F", onClick: () => alert("Search (not wired)") },
            { icon: "check2",   label: "Mark all as read",            onClick: onMarkRead },
            { icon: "clock",    label: "Mute notifications",          onClick: onMute     },
            { icon: "pin",      label: "Pin to top",                  onClick: onPin      },
            { divider: true },
            { icon: "logs",     label: "Open audit log",              onClick: onOpenAudit },
            { icon: "users",    label: "Members",                     onClick: onOpenMembers   },
            { icon: "settings", label: "Room settings",               onClick: onOpenSettings  },
            { divider: true },
            { icon: "archive",  label: "Archive room",                onClick: onArchive  },
            { icon: "x",        label: "Leave room",     danger: true, onClick: onLeave   },
          ]}
        />
      )}
    </header>
  );
};

/* ---- Avatar ---- */
const Avatar = ({ id }) => {
  const p = PEOPLE[id];
  if (!p) return null;
  if (p.kind === "agent") {
    return <div className="avatar agent" title={`${p.name} — agent, operated by ${p.op}`}>{p.short}</div>;
  }
  return <div className="avatar" style={{ background: p.color }}>{p.initials}</div>;
};

/* ---- Author line ---- */
const Author = ({ id }) => {
  const p = PEOPLE[id];
  if (!p) return null;
  if (p.kind === "agent") return <span className="author"><AgentTag id={id}/></span>;
  return (
    <span className="author">
      {p.name}
      {p.origin && <span className="origin"> · {p.origin}</span>}
    </span>
  );
};

/* ---- Message ---- */
const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "🙏", "🔥", "✅", "👀"];

const ReplyContext = ({ replyToMsg, onJump }) => {
  if (!replyToMsg) return null;
  const author = PEOPLE[replyToMsg.from];
  const isDeleted = replyToMsg.deleted;
  const preview = isDeleted
    ? "deleted message"
    : (replyToMsg.text || (replyToMsg.inlay
        ? `[${replyToMsg.inlay.kind === "task-card" ? "task" : replyToMsg.inlay.kind}] ${replyToMsg.inlay.title || replyToMsg.inlay.question || ""}`
        : ""));
  return (
    <button className="reply-context" onClick={onJump} type="button">
      <span className="rc-curve" aria-hidden="true"/>
      <span className="rc-body">
        <Icon name="reply" size={11}/>
        <span className="rc-who">{author?.name || "Unknown"}</span>
        <span className={"rc-text" + (isDeleted ? " deleted" : "")}>{preview}</span>
      </span>
    </button>
  );
};

const QuoteBlock = ({ quote }) => {
  if (!quote) return null;
  const author = PEOPLE[quote.fromId];
  return (
    <div className="quote">
      <div className="q-head">
        <Icon name="quote" size={11}/>
        <span className="q-who">{author?.name || "Unknown"}</span>
        {quote.t && <span>· {quote.t}</span>}
      </div>
      <div className="q-text">{quote.text}</div>
    </div>
  );
};

const ReactionsRow = ({ reactions, onToggle, onAddRequest }) => {
  if (!reactions || reactions.length === 0) return null;
  return (
    <div className="reactions">
      {reactions.map(r => {
        const mine = r.by.includes("u_me");
        const names = r.by.map(id => (PEOPLE[id]?.name) || (id === "u_me" ? "You" : id));
        return (
          <button
            key={r.emoji}
            type="button"
            className={"reaction" + (mine ? " mine" : "")}
            onClick={() => onToggle(r.emoji)}
            title={`${names.join(", ")} reacted with ${r.emoji}`}
          >
            <span className="rx-e">{r.emoji}</span>
            <span className="rx-c">{r.by.length}</span>
          </button>
        );
      })}
      <button type="button" className="reaction add" onClick={onAddRequest} title="Add reaction">
        <Icon name="smileplus" size={13}/>
      </button>
    </div>
  );
};

/* small quick-react popover: 8 quick picks + "more" → full EmojiPicker */
const QuickReactPopover = ({ anchorRect, onPick, onMore, onClose }) => {
  React.useEffect(() => {
    const onClick = (e) => { if (!e.target.closest(".rx-pop")) onClose(); };
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  if (!anchorRect) return null;
  const width = 290;
  const height = 50;
  let top = anchorRect.top - height - 2;
  if (top < 8) top = anchorRect.bottom + 6;
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, anchorRect.left - 20));
  return (
    <div className="rx-pop" style={{ top, left, width, padding: 0 }}>
      <div className="quick-react">
        {QUICK_REACTIONS.map(e => (
          <button key={e} className="qr-btn" onClick={() => onPick(e)}>{e}</button>
        ))}
        <button className="qr-btn more" onClick={onMore} title="More reactions…">
          <Icon name="plus" size={12}/>
        </button>
      </div>
    </div>
  );
};

const EditForm = ({ initial, onSave, onCancel }) => {
  const [val, setVal] = React.useState(initial || "");
  const ref = React.useRef(null);
  React.useEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.focus();
    const len = ta.value.length;
    ta.setSelectionRange(len, len);
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 220) + "px";
  }, []);
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); onCancel(); return; }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const t = val.trim();
      if (t && t !== initial) onSave(t); else onCancel();
    }
  };
  const grow = (e) => {
    setVal(e.target.value);
    const ta = e.target;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 220) + "px";
  };
  return (
    <div className="edit-form">
      <textarea ref={ref} value={val} onChange={grow} onKeyDown={onKey}/>
      <div className="ef-actions">
        <span className="ef-hint"><kbd>Enter</kbd> save · <kbd>Esc</kbd> cancel</span>
        <span className="grow"/>
        <button className="btn sm ghost" onClick={onCancel}>Cancel</button>
        <button
          className="btn sm primary"
          onClick={() => { const t = val.trim(); if (t && t !== initial) onSave(t); else onCancel(); }}
          disabled={!val.trim() || val.trim() === initial}
        >
          Save
        </button>
      </div>
    </div>
  );
};

const Message = ({
  msg, dense, transportHint, InlayRenderer,
  replyToMsg, isEditing,
  onReact, onReply, onQuote, onCopy, onStartEdit, onSaveEdit, onCancelEdit, onDelete,
  onJumpTo,
}) => {
  /* system messages (joins/leaves/invites) render as a centered chip */
  if (msg.system) {
    const actor = PEOPLE[msg.actorId];
    const target = PEOPLE[msg.targetId];
    const isAgentEvent = target?.kind === "agent" || actor?.kind === "agent";
    const verb = (() => {
      switch (msg.kind) {
        case "member-add":
        case "agent-add":   return "added";
        case "agent-leave":
        case "leave":       return "left";
        case "join":        return "joined";
        case "remove":      return "removed";
        default:            return msg.verb || "·";
      }
    })();
    const kindClass = isAgentEvent
      ? (msg.kind === "agent-leave" || msg.kind === "leave" ? "kind-leave" : "kind-agent-add")
      : (msg.kind === "leave" ? "kind-leave" : "");
    return (
      <div className={"sys-msg " + kindClass} data-msg-id={msg.id}>
        <span className="sys-chip">
          <span className="sys-icon">
            <Icon name={isAgentEvent ? "spark" : "users"} size={10}/>
          </span>
          {actor && <span className="sys-actor">{actor.name}</span>}
          <span>{verb}</span>
          {target && (
            <span className="sys-target">
              {target.name}
              {target.kind === "agent" && <span className="sys-target-agt">AGT</span>}
            </span>
          )}
          {msg.note && <span> · {msg.note}</span>}
          <span className="sys-time">· {msg.t}</span>
        </span>
      </div>
    );
  }

  const isMine = msg.from === "u_me";
  const isAgent = !!PEOPLE[msg.from]?.agent;
  const canEdit = isMine && !msg.deleted && !msg.inlay && !!msg.text;
  const canDelete = isMine && !msg.deleted;
  const isDeleted = !!msg.deleted;

  const [quickRect, setQuickRect] = React.useState(null);
  const [fullEmojiRect, setFullEmojiRect] = React.useState(null);
  const [kebabRect, setKebabRect] = React.useState(null);
  const reactBtnRef = React.useRef(null);
  const kebabBtnRef = React.useRef(null);
  const rootRef = React.useRef(null);

  const popoverOpen = !!(quickRect || fullEmojiRect || kebabRect);

  const openQuick = () => {
    const r = reactBtnRef.current?.getBoundingClientRect();
    if (r) setQuickRect({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
  };
  const openFullEmoji = () => {
    setQuickRect(null);
    const r = reactBtnRef.current?.getBoundingClientRect();
    if (r) setFullEmojiRect({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
  };
  const openKebab = () => {
    const r = kebabBtnRef.current?.getBoundingClientRect();
    if (r) setKebabRect({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
  };

  const kebabItems = [
    { label: "Copy text", icon: "copy", hint: "⌘C", onClick: () => onCopy(msg), disabled: !msg.text },
    { label: "Quote", icon: "quote", onClick: () => onQuote(msg), disabled: !msg.text },
    { label: "Reply in thread", icon: "reply", onClick: () => onReply(msg) },
    { divider: true },
    canEdit && { label: "Edit message", icon: "edit", onClick: () => onStartEdit(msg) },
    canDelete && { label: "Delete message", icon: "trash", danger: true, onClick: () => onDelete(msg) },
    !canEdit && !canDelete && { label: "Copy link", icon: "pin", onClick: () => onCopy(msg, { kind: "link" }) },
  ].filter(Boolean);

  return (
    <div
      ref={rootRef}
      className={"msg" + (dense ? " dense" : "") + (isMine ? " mine" : "") + (isDeleted ? " deleted" : "") + (popoverOpen ? " actions-open" : "")}
      data-msg-id={msg.id}
    >
      {/* hover action bar */}
      {!isDeleted && !isEditing && (
        <div className="msg-actions" onMouseDown={(e) => e.stopPropagation()}>
          <button
            ref={reactBtnRef}
            type="button"
            className="ma-btn"
            title="Add reaction"
            onClick={openQuick}
          >
            <Icon name="smileplus" size={14}/>
          </button>
          <button
            type="button"
            className="ma-btn"
            title="Reply"
            onClick={() => onReply(msg)}
          >
            <Icon name="reply" size={14}/>
          </button>
          {msg.text && (
            <button
              type="button"
              className="ma-btn"
              title="Quote"
              onClick={() => onQuote(msg)}
            >
              <Icon name="quote" size={14}/>
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              className="ma-btn"
              title="Edit"
              onClick={() => onStartEdit(msg)}
            >
              <Icon name="edit" size={14}/>
            </button>
          )}
          <span className="ma-sep"/>
          <button
            ref={kebabBtnRef}
            type="button"
            className="ma-btn"
            title="More"
            onClick={openKebab}
          >
            <Icon name="kebab" size={14}/>
          </button>
        </div>
      )}

      <div>{!dense && <Avatar id={msg.from}/>}</div>
      <div className="body">
        {!dense && (
          <div className="head">
            <Author id={msg.from}/>
            <span className="time">{msg.t}</span>
            {msg.edited && !isDeleted && <span className="edited" title="This message was edited">(edited)</span>}
          </div>
        )}

        {/* reply pointer */}
        {!isDeleted && msg.replyTo && (
          <ReplyContext
            replyToMsg={replyToMsg}
            onJump={() => onJumpTo?.(msg.replyTo)}
          />
        )}

        {/* embedded quote */}
        {!isDeleted && msg.quote && <QuoteBlock quote={msg.quote}/>}

        {/* text / edit form */}
        {isEditing ? (
          <EditForm
            initial={msg.text || ""}
            onSave={(t) => onSaveEdit(msg, t)}
            onCancel={() => onCancelEdit(msg)}
          />
        ) : (
          <>
            {isDeleted ? (
              <div className="text">
                <Icon name="trash" size={12}/> This message was deleted
              </div>
            ) : msg.text ? (
              <div className="text">{msg.text}</div>
            ) : null}
            {msg.inlay && <InlayRenderer inlay={msg.inlay} msgId={msg.id} fromId={msg.from}/>}
          </>
        )}

        {/* reactions row */}
        {!isDeleted && !isEditing && (
          <ReactionsRow
            reactions={msg.reactions}
            onToggle={(emoji) => onReact(msg, emoji)}
            onAddRequest={openQuick}
          />
        )}

        {msg.state && !isDeleted && !isEditing && (
          <span className="state">
            {msg.state === "sending"  && <><Icon name="clock" size={10}/> sending</>}
            {msg.state === "sent"     && <><Icon name="check" size={10}/> sent</>}
            {msg.state === "queued"   && <><Icon name="clock" size={10}/> pending — no route</>}
            {msg.state === "delivered"&& <><Icon name="check2" size={10}/> delivered · path unknown</>}
            {msg.state === "sent" && transportHint && <span> · via {transportHint}</span>}
          </span>
        )}
      </div>

      {/* popovers */}
      {quickRect && (
        <QuickReactPopover
          anchorRect={quickRect}
          onClose={() => setQuickRect(null)}
          onPick={(emoji) => { onReact(msg, emoji); setQuickRect(null); }}
          onMore={openFullEmoji}
        />
      )}
      {fullEmojiRect && (
        <window.EmojiPicker
          anchorRect={fullEmojiRect}
          onClose={() => setFullEmojiRect(null)}
          onPick={(emoji) => { onReact(msg, emoji); setFullEmojiRect(null); }}
        />
      )}
      {kebabRect && (
        <window.KebabMenu
          anchorRect={kebabRect}
          onClose={() => setKebabRect(null)}
          items={kebabItems}
        />
      )}
    </div>
  );
};

/* ---- Composer ---- */
const Composer = ({ room, transportMode, onSend, onSlash, replyTo, quote, onClearContext }) => {
  const [text, setText] = React.useState("");
  const [showSlash, setShowSlash] = React.useState(false);
  const [slashSel, setSlashSel] = React.useState(0);
  const [emojiRect,   setEmojiRect]   = React.useState(null);
  const [mentionRect, setMentionRect] = React.useState(null);
  const taRef = React.useRef(null);
  const emojiBtnRef   = React.useRef(null);
  const mentionBtnRef = React.useRef(null);
  const fileRef = React.useRef(null);

  /* refocus when a reply/quote context is set */
  React.useEffect(() => {
    if (replyTo || quote) {
      requestAnimationFrame(() => taRef.current?.focus());
    }
  }, [replyTo?.id, quote?.fromId, quote?.text]);

  const slashCmds = [
    { cmd: "/task",   desc: "Add a task to an agent",          ret: "open modal" },
    { cmd: "/poll",   desc: "Start a poll",                    ret: "inline inlay" },
    { cmd: "/call",   desc: "Start a call",                    ret: "ring members" },
    { cmd: "/invite", desc: "Add a member to this room",       ret: "modal" },
    { cmd: "/field",  desc: "Switch to mesh-first transport",  ret: "session"      },
    { cmd: "/home",   desc: "Switch to LAN-first transport",   ret: "session"      },
    { cmd: "/mute",   desc: "Mute this room",                  ret: "this room"    },
  ];
  const filtered = slashCmds.filter(c => c.cmd.startsWith(text.trim()) || text.trim() === "/");

  React.useEffect(() => {
    setShowSlash(text.startsWith("/") && filtered.length > 0);
    setSlashSel(0);
    if (taRef.current) {
      taRef.current.style.height = "auto";
      taRef.current.style.height = Math.min(taRef.current.scrollHeight, 160) + "px";
    }
  }, [text]);

  const submit = () => {
    const t = text.trim();
    if (!t && !quote) return;
    if (t.startsWith("/")) {
      onSlash?.(t);
      setText("");
      return;
    }
    onSend(t, { replyTo: replyTo?.id, quote });
    setText("");
    onClearContext?.();
  };

  const insertAtCursor = (insertion) => {
    const ta = taRef.current;
    if (!ta) { setText(text + insertion); return; }
    const start = ta.selectionStart ?? text.length;
    const end   = ta.selectionEnd   ?? text.length;
    const before = text.slice(0, start);
    const after  = text.slice(end);
    const needSpaceBefore = before && !/\s$/.test(before) && !insertion.startsWith(" ");
    const join = needSpaceBefore ? " " : "";
    const next = before + join + insertion + after;
    setText(next);
    requestAnimationFrame(() => {
      const pos = (before + join + insertion).length;
      ta.focus();
      ta.setSelectionRange(pos, pos);
    });
  };

  const keyDown = (e) => {
    if (showSlash) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSlashSel((slashSel + 1) % filtered.length); return; }
      if (e.key === "ArrowUp")   { e.preventDefault(); setSlashSel((slashSel - 1 + filtered.length) % filtered.length); return; }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        onSlash?.(filtered[slashSel].cmd);
        setText("");
        return;
      }
      if (e.key === "Escape") { setShowSlash(false); return; }
    }
    if (e.key === "Escape" && (replyTo || quote)) {
      e.preventDefault();
      onClearContext?.();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const transportLabel = (() => {
    if (transportMode === "FIELD" || transportMode === "MESH-ONLY") return "via mesh";
    if (transportMode === "HOME"  || transportMode === "AUTO")      return "via LAN";
    return transportMode.toLowerCase();
  })();

  const onAttachFiles = (files) => {
    if (!files || !files.length) return;
    const names = Array.from(files).map(f => f.name).join(", ");
    insertAtCursor(`📎 ${names}`);
  };

  return (
    <div className="composer-wrap" style={{ position: "relative" }}>
      {showSlash && (
        <div className="slash-menu">
          <div className="h">Slash commands</div>
          {filtered.map((c, i) => (
            <div
              key={c.cmd}
              className="opt"
              aria-selected={i === slashSel ? "true" : "false"}
              onMouseEnter={() => setSlashSel(i)}
              onClick={() => { onSlash?.(c.cmd); setText(""); }}
            >
              <span className="cmd">{c.cmd}</span>
              <span className="desc">{c.desc}</span>
              <span className="ret">↵</span>
            </div>
          ))}
        </div>
      )}
      {(replyTo || quote) && (() => {
        const isReply = !!replyTo;
        const ctxMsg = isReply ? replyTo : null;
        const author = isReply ? PEOPLE[ctxMsg.from] : PEOPLE[quote.fromId];
        const deleted = isReply && ctxMsg.deleted;
        const text = isReply
          ? (deleted ? "deleted message" : (ctxMsg.text || (ctxMsg.inlay
              ? `[${ctxMsg.inlay.kind === "task-card" ? "task" : ctxMsg.inlay.kind}] ${ctxMsg.inlay.title || ctxMsg.inlay.question || ""}`
              : "")))
          : quote.text;
        return (
          <div className="composer-context" role="status">
            <span className="cc-mode">
              <Icon name={isReply ? "reply" : "quote"} size={11}/>
              {isReply ? "Replying to" : "Quoting"}
            </span>
            <span className="cc-who">{author?.name || "Unknown"}</span>
            <span className={"cc-text" + (deleted ? " deleted" : "")}>{text}</span>
            <button className="cc-close" onClick={onClearContext} title="Cancel (Esc)">
              <Icon name="x" size={12}/>
            </button>
          </div>
        );
      })()}
      <div className="composer">
        <textarea
          ref={taRef}
          rows={1}
          placeholder={`Message ${room.glyph}${room.name} — type / for commands`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={keyDown}
        />
        <input
          ref={fileRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={(e) => { onAttachFiles(e.target.files); e.target.value = ""; }}
        />
        <div className="row">
          <button className="icon-btn" title="Attach" onClick={() => fileRef.current?.click()}><Icon name="attach"/></button>
          <button
            ref={emojiBtnRef}
            className="icon-btn"
            title="Emoji"
            onClick={() => {
              const r = emojiBtnRef.current?.getBoundingClientRect();
              setEmojiRect(r ? { top: r.top, bottom: r.bottom, left: r.left, right: r.right } : null);
            }}
          >
            <Icon name="smile"/>
          </button>
          <button
            ref={mentionBtnRef}
            className="icon-btn"
            title="Mention"
            onClick={() => {
              const r = mentionBtnRef.current?.getBoundingClientRect();
              setMentionRect(r ? { top: r.top, bottom: r.bottom, left: r.left, right: r.right } : null);
            }}
          >
            <Icon name="person"/>
          </button>
          <div className="spacer"/>
          <span className={"hint" + (transportLabel === "via mesh" ? " via-mesh" : "")}
                title="Transport hint — click to override for this message">
            <span className="hint-dot"/>
            {transportLabel}
          </span>
          <button className="send" disabled={!text.trim() && !quote} onClick={submit}>
            <Icon name="send" size={12}/>
            Send
          </button>
        </div>
      </div>

      {emojiRect && (
        <window.EmojiPicker
          anchorRect={emojiRect}
          onClose={() => setEmojiRect(null)}
          onPick={(emoji) => { insertAtCursor(emoji); }}
        />
      )}

      {mentionRect && (
        <window.MentionMenu
          anchorRect={mentionRect}
          room={room}
          onClose={() => setMentionRect(null)}
          onPick={({ mention }) => {
            insertAtCursor(mention + " ");
            setMentionRect(null);
          }}
        />
      )}
    </div>
  );
};

Object.assign(window, {
  AgentTag, SpaceRail, RoomList, RoomHeader, Avatar, Author, Message, Composer,
});
