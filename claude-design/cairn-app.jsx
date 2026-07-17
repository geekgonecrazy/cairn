/* Main App: state, layout, tweaks, interactions */
const {
  Icon, AgentTag, SpaceRail, RoomList, RoomHeader, Message, Composer,
  InlayRenderer, AgentPanel, CapabilitiesCard, MembersCard, AddTaskModal,
  ApprovalDetailsModal,
  CAIRN,
  TweaksPanel, useTweaks, TweakSection, TweakRadio, TweakToggle,
} = window;
const { PEOPLE, SPACES, ROOMS: SEED_ROOMS } = CAIRN;

/* ----- initial tweakable defaults (persisted) ----- */
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "light",
  "panelPlacement": "sidebar"
}/*EDITMODE-END*/;

/* ----- initial agent tasks ----- */
const INITIAL_TASKS = [
  { id: "t1", title: "Irrigate bed 3",            state: "running", progress: 0.78 },
  { id: "t2", title: "Inspect bed 7",             state: "running", progress: 0.12 },
  { id: "t3", title: "Compost rotation check",    state: "running", progress: 0.03 },
  { id: "t4", title: "Sensor calibration",        state: "queued"   },
  { id: "t5", title: "Weekly trend report",       state: "queued"   },
  { id: "t6", title: "Water beds 1–2 (light)",    state: "done"     },
  { id: "t7", title: "Inspect bed 7",             state: "done"     },
  { id: "t8", title: "Trim east-row tomatoes",    state: "done"     },
];

const App = () => {
  /* theme + placement via tweaks */
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);

  React.useEffect(() => {
    document.documentElement.setAttribute("data-theme", t.theme);
  }, [t.theme]);

  /* navigation */
  const [activeSpace, setActiveSpace] = React.useState("sp_home");
  const [activeRoomId, setActiveRoomId] = React.useState("r_garden");
  const [mobileView, setMobileView] = React.useState("room"); /* "rooms" | "room" */

  /* spaces (mutable so we can add new ones) */
  const [spaces, setSpaces] = React.useState(() => SPACES.map(s => ({ ...s })));

  /* room order (mutable so we can append new rooms) */
  const [roomOrder, setRoomOrder] = React.useState(() => SEED_ROOMS.map(r => r.id));

  /* per-room messages (start from seed, mutable so we can append) */
  const [roomsState, setRoomsState] = React.useState(() =>
    Object.fromEntries(SEED_ROOMS.map(r => [r.id, { ...r, messages: r.messages.map(m => ({ ...m })) }]))
  );
  const rooms = roomOrder.map(id => roomsState[id]).filter(Boolean);

  /* agent tasks (garden agent) */
  const [tasks, setTasks] = React.useState(INITIAL_TASKS);

  /* transport mode (auto / home / field / mesh-only) */
  const [transportMode, setTransportMode] = React.useState("AUTO");

  /* modals */
  const [showAddTask, setShowAddTask] = React.useState(false);
  const [detailsMsgId, setDetailsMsgId] = React.useState(null);
  const [videoTheaterMsgId, setVideoTheaterMsgId] = React.useState(null);
  const [showMembers, setShowMembers] = React.useState(false);
  const [showSettings, setShowSettings] = React.useState(false);
  const [showAudit, setShowAudit] = React.useState(false);
  const [showCreateSpace, setShowCreateSpace] = React.useState(false);
  const [createChannelFor, setCreateChannelFor] = React.useState(null); /* spaceId | null */
  const [toast, setToast] = React.useState(null);
  const showToast = (msg) => {
    setToast(msg);
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => setToast(null), 2400);
  };

  /* side panel visibility + per-card collapse state */
  const [sidebarOpen, setSidebarOpen] = React.useState(() => window.innerWidth > 900);
  const [cardCollapsed, setCardCollapsed] = React.useState({
    agent: false,
    capabilities: false,
  });
  const toggleCard = (key) => setCardCollapsed(prev => ({ ...prev, [key]: !prev[key] }));

  /* responsive detection */
  const [isMobile, setIsMobile] = React.useState(() => window.innerWidth <= 900);
  React.useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= 900);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /* simulate task progress every 2.5s */
  React.useEffect(() => {
    const t = setInterval(() => {
      setTasks(prev => prev.map(task => {
        if (task.state !== "running") return task;
        const next = Math.min(1, task.progress + (Math.random() * 0.04 + 0.005));
        if (next >= 1) return { ...task, progress: 1, state: "done" };
        return { ...task, progress: next };
      }));
    }, 2500);
    return () => clearInterval(t);
  }, []);

  const activeRoom = rooms.find(r => r.id === activeRoomId);

  /* auto-switch space when picking a room from elsewhere */
  React.useEffect(() => {
    if (activeRoom && activeRoom.space !== activeSpace) {
      setActiveSpace(activeRoom.space);
    }
  }, [activeRoomId]);

  /* scroll-to-bottom on new message in active room */
  const bodyRef = React.useRef(null);
  const lastMsgCount = React.useRef(0);
  React.useEffect(() => {
    const count = activeRoom?.messages.length ?? 0;
    if (count !== lastMsgCount.current && bodyRef.current) {
      requestAnimationFrame(() => {
        bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
      });
      lastMsgCount.current = count;
    }
  }, [activeRoom?.messages.length, activeRoomId]);

  /* ----- actions ----- */
  const transportLabel = (
    transportMode === "FIELD" || transportMode === "MESH-ONLY" ? "mesh" : "LAN"
  );

  const sendMessage = (text, ctx) => {
    const id = "m_" + Math.random().toString(36).slice(2, 9);
    const newMsg = {
      id, t: nowTime(), from: "u_me", text,
      state: "sending",
      ...(ctx?.replyTo ? { replyTo: ctx.replyTo } : {}),
      ...(ctx?.quote ? { quote: ctx.quote } : {}),
    };
    setRoomsState(prev => ({
      ...prev,
      [activeRoomId]: {
        ...prev[activeRoomId],
        messages: [...prev[activeRoomId].messages, newMsg],
      }
    }));
    /* state transitions */
    setTimeout(() => updateMsg(activeRoomId, id, { state: "sent", transport: transportLabel }), 650);
    setTimeout(() => updateMsg(activeRoomId, id, { state: "delivered", transport: transportLabel }), 1900);
  };

  /* ----- message actions: react / reply / quote / edit / copy / delete ----- */
  const [composerCtx, setComposerCtx] = React.useState(null);  /* { roomId, kind:"reply"|"quote", msgId, quote? } */
  const [editingId, setEditingId]     = React.useState(null);  /* msg id being edited (within active room) */
  React.useEffect(() => {
    /* clear context & edit when switching rooms */
    setComposerCtx(null);
    setEditingId(null);
  }, [activeRoomId]);

  const onReact = (msg, emoji) => {
    setRoomsState(prev => ({
      ...prev,
      [activeRoomId]: {
        ...prev[activeRoomId],
        messages: prev[activeRoomId].messages.map(m => {
          if (m.id !== msg.id) return m;
          const rx = Array.isArray(m.reactions) ? m.reactions.map(r => ({ ...r, by: [...r.by] })) : [];
          const existing = rx.find(r => r.emoji === emoji);
          if (existing) {
            if (existing.by.includes("u_me")) {
              existing.by = existing.by.filter(id => id !== "u_me");
            } else {
              existing.by.push("u_me");
            }
          } else {
            rx.push({ emoji, by: ["u_me"] });
          }
          const cleaned = rx.filter(r => r.by.length > 0);
          return { ...m, reactions: cleaned };
        }),
      }
    }));
  };

  const onReply = (msg) => {
    setComposerCtx({ kind: "reply", msgId: msg.id });
    setEditingId(null);
  };

  const onQuote = (msg) => {
    if (!msg.text) return;
    setComposerCtx({
      kind: "quote",
      quote: { fromId: msg.from, text: msg.text, t: msg.t, srcId: msg.id }
    });
    setEditingId(null);
  };

  const onCopy = (msg, opt) => {
    const payload = opt?.kind === "link"
      ? `cairn://room/${activeRoomId}/msg/${msg.id}`
      : (msg.text || (msg.inlay?.title || msg.inlay?.question || ""));
    if (!payload) { showToast("Nothing to copy"); return; }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(payload).then(
        () => showToast(opt?.kind === "link" ? "Link copied" : "Copied to clipboard"),
        () => showToast("Couldn't copy — clipboard blocked")
      );
    } else {
      showToast("Copied");
    }
  };

  const onStartEdit = (msg) => {
    setEditingId(msg.id);
    setComposerCtx(null);
  };
  const onCancelEdit = () => setEditingId(null);
  const onSaveEdit = (msg, nextText) => {
    updateMsg(activeRoomId, msg.id, { text: nextText, edited: true });
    setEditingId(null);
    showToast("Message updated");
  };

  const onDelete = (msg) => {
    /* soft-delete: keep the slot so threads still resolve */
    updateMsg(activeRoomId, msg.id, {
      deleted: true, text: null, inlay: null, reactions: [],
      state: undefined, edited: false,
    });
    if (editingId === msg.id) setEditingId(null);
    showToast("Message deleted");
  };

  const onJumpTo = (msgId) => {
    const el = bodyRef.current?.querySelector(`[data-msg-id="${msgId}"]`);
    if (!el || !bodyRef.current) return;
    const container = bodyRef.current;
    const targetTop = el.offsetTop - container.clientHeight / 3;
    container.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
    el.classList.remove("flash");
    /* force reflow so the animation restarts */
    void el.offsetWidth;
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 1400);
  };

  /* ----- create space / create channel ----- */

  const onSuggestionAdd = (msgId, suggestionId) => {
    /* mark the suggestion as added in the inlay, and add a corresponding option to the targeted poll */
    setRoomsState(prev => {
      const room = prev[activeRoomId];
      if (!room) return prev;
      const srcMsg = room.messages.find(m => m.id === msgId);
      if (!srcMsg?.inlay) return prev;
      const item = srcMsg.inlay.items.find(it => it.id === suggestionId);
      if (!item) return prev;
      const alreadyAdded = (srcMsg.inlay.added || []).includes(suggestionId);
      if (alreadyAdded) return prev;
      const pollId = srcMsg.inlay.targetPollId;

      const messages = room.messages.map(m => {
        if (m.id === msgId) {
          return {
            ...m,
            inlay: { ...m.inlay, added: [...(m.inlay.added || []), suggestionId] },
          };
        }
        if (pollId && m.id === pollId && m.inlay?.kind === "poll") {
          const existing = m.inlay.options.find(o => o.label === item.title);
          if (existing) return m;
          const newOpt = { id: "p_" + Math.random().toString(36).slice(2, 6), label: item.title, votes: 0, voters: [] };
          return {
            ...m,
            inlay: {
              ...m.inlay,
              options: [...m.inlay.options, newOpt],
              activity: [
                ...(m.inlay.activity || []),
                { t: nowTime(), who: "a_reels", what: `added "${item.title}" as an option` },
              ],
            },
          };
        }
        return m;
      });

      const confirmId = "m_" + Math.random().toString(36).slice(2, 8);
      const closesAt = room.messages.find(m => m.id === pollId)?.inlay?.closesAt;
      messages.push({
        id: confirmId,
        t: nowTime(),
        from: "a_reels",
        text: pollId
          ? `Added "${item.title}" to the poll${closesAt ? ` — still closes at ${closesAt}` : ""}.`
          : `Got it — "${item.title}" picked.`,
        state: "delivered",
      });

      return { ...prev, [activeRoomId]: { ...room, messages } };
    });
    showToast("Added to the poll");
  };

  const onCreateSpace = ({ name, short, desc, reach }) => {
    const id = "sp_" + Math.random().toString(36).slice(2, 8);
    setSpaces(prev => [...prev, {
      id, short, name, hasUnread: false,
      desc, reach,
    }]);
    setActiveSpace(id);
    setShowCreateSpace(false);
    setMobileView("rooms");
    showToast(`Space "${name}" created`);
  };

  const onCreateChannel = ({ name, glyph, private: isPrivate, spaceId, desc, xh, members, agentIds }) => {
    const id = "r_" + Math.random().toString(36).slice(2, 8);
    const space = spaces.find(s => s.id === spaceId);
    const hasAgent = agentIds && agentIds.length > 0;
    const kind = hasAgent ? "agent-room" : (xh ? "xh-group" : (isPrivate ? "private" : "group"));
    const agentSummary = hasAgent
      ? (agentIds.length === 1
          ? `${PEOPLE[agentIds[0]]?.name || "Agent"} attached`
          : `${agentIds.length} agents attached`)
      : null;
    const newRoom = {
      id,
      space: spaceId,
      name,
      glyph: isPrivate ? "🔒" : "#",
      kind,
      members,
      subtitle: `${members.length} member${members.length !== 1 ? "s" : ""}${agentSummary ? " · " + agentSummary : ""}${xh ? " · cross-household" : ""}`,
      transport: xh ? "mesh" : "lan",
      xh: !!xh,
      unread: 0,
      desc,
      messages: [
        {
          id: "sys_" + Math.random().toString(36).slice(2, 7),
          t: nowTime(),
          from: "u_me",
          text: `Created ${isPrivate ? "private " : ""}channel ${glyph}${name}${desc ? ` — ${desc}` : ""}.`,
          state: "delivered",
        },
      ],
    };
    setRoomsState(prev => ({ ...prev, [id]: newRoom }));
    setRoomOrder(prev => [...prev, id]);
    setActiveSpace(spaceId);
    setActiveRoomId(id);
    setCreateChannelFor(null);
    setMobileView("room");
    showToast(`Channel ${glyph}${name} created in ${space?.name || "space"}`);
  };

  const updateMsg = (roomId, msgId, patch) => {
    setRoomsState(prev => ({
      ...prev,
      [roomId]: {
        ...prev[roomId],
        messages: prev[roomId].messages.map(m => m.id === msgId ? { ...m, ...patch } : m),
      }
    }));
  };

  const onPollVoteIn = (roomId, msgId, optionId) => {
    setRoomsState(prev => {
      const room = prev[roomId];
      if (!room) return prev;
      return {
        ...prev,
        [roomId]: {
          ...room,
          messages: room.messages.map(m => {
            if (m.id !== msgId || !m.inlay || m.inlay.kind !== "poll") return m;
            const prevVote = m.inlay.myVote;
            const options = m.inlay.options.map(o => {
              const wasVoter = (o.voters ?? []).includes("u_me");
              let voters = o.voters ? [...o.voters] : [];
              let v = o.votes;
              if (prevVote === o.id) { v -= 1; voters = voters.filter(x => x !== "u_me"); }
              if (o.id === optionId) { v += 1; if (!wasVoter || prevVote !== o.id) { if (!voters.includes("u_me")) voters.push("u_me"); } }
              return { ...o, votes: v, voters };
            });
            return { ...m, inlay: { ...m.inlay, options, myVote: optionId } };
          })
        }
      };
    });
  };

  const onPollVote = (msgId, optionId) => onPollVoteIn(activeRoomId, msgId, optionId);

  const onApproval = (msgId, decision) => {
    setRoomsState(prev => {
      const room = prev[activeRoomId];
      return {
        ...prev,
        [activeRoomId]: {
          ...room,
          messages: room.messages.map(m =>
            (m.id === msgId && m.inlay?.kind === "approval")
              ? { ...m, inlay: { ...m.inlay, state: decision } }
              : m
          )
        }
      };
    });
    /* if approved, simulate agent following up with a task progress note */
    if (decision === "approved") {
      setTimeout(() => {
        const id = "m_" + Math.random().toString(36).slice(2, 9);
        setRoomsState(prev => ({
          ...prev,
          [activeRoomId]: {
            ...prev[activeRoomId],
            messages: [...prev[activeRoomId].messages, {
              id, t: nowTime(), from: "a_garden",
              text: "Capability granted. Starting bed-3 irrigation cycle now — 12 minutes."
            }]
          }
        }));
      }, 800);
    } else if (decision === "denied") {
      setTimeout(() => {
        const id = "m_" + Math.random().toString(36).slice(2, 9);
        setRoomsState(prev => ({
          ...prev,
          [activeRoomId]: {
            ...prev[activeRoomId],
            messages: [...prev[activeRoomId].messages, {
              id, t: nowTime(), from: "a_garden",
              text: "Acknowledged. Skipping irrigation; I'll flag bed 3 in the next trend report."
            }]
          }
        }));
      }, 800);
    }
  };

  /* ============ CALL handlers ============ */
  const updateInlay = (roomId, msgId, patch) => {
    setRoomsState(prev => ({
      ...prev,
      [roomId]: {
        ...prev[roomId],
        messages: prev[roomId].messages.map(m =>
          m.id === msgId && m.inlay
            ? { ...m, inlay: typeof patch === "function" ? patch(m.inlay) : { ...m.inlay, ...patch } }
            : m
        )
      }
    }));
  };

  const onStartCall = () => {
    const room = roomsState[activeRoomId];
    if (!room) return;
    const id = "m_" + Math.random().toString(36).slice(2, 9);
    const others = room.members.filter(m => m !== "u_me" && PEOPLE[m]?.kind === "human");
    const participants = [
      { id: "u_me", conn: "self",    muted: false, talking: true  },
      ...others.map(pid => ({ id: pid, conn: "ringing", muted: false, talking: false })),
    ];
    setRoomsState(prev => ({
      ...prev,
      [activeRoomId]: {
        ...prev[activeRoomId],
        messages: [...prev[activeRoomId].messages, {
          id, t: nowTime(), from: "u_me",
          inlay: {
            kind: "call",
            state: "ringing",
            startedAt: Date.now(),
            startedBy: "u_me",
            participants,
          }
        }]
      }
    }));
    /* Simulate participants picking up over time */
    if (others.length > 0) {
      setTimeout(() => {
        updateInlay(activeRoomId, id, prev => ({
          ...prev,
          state: "active",
          startedAt: Date.now(),
          participants: prev.participants.map(p =>
            p.id === others[0] ? { ...p, conn: "joined", talking: false } : p
          ),
        }));
      }, 1800);
    }
    if (others.length > 1) {
      setTimeout(() => {
        updateInlay(activeRoomId, id, prev => ({
          ...prev,
          participants: prev.participants.map(p =>
            p.id === others[1] ? { ...p, conn: "joined", talking: true } : p
          ),
        }));
      }, 3400);
    }
    if (others.length > 2) {
      setTimeout(() => {
        updateInlay(activeRoomId, id, prev => ({
          ...prev,
          participants: prev.participants.map(p =>
            p.id === others[2] ? { ...p, conn: "declined" } : p
          ),
        }));
      }, 4400);
    }
  };

  const onCallUpdate = (msgId, patch) => {
    if (patch.toggleMute) {
      updateInlay(activeRoomId, msgId, prev => ({
        ...prev,
        participants: prev.participants.map(p =>
          p.conn === "self" ? { ...p, muted: !p.muted, talking: p.muted ? p.talking : false } : p
        ),
      }));
    }
  };

  const onCallEnd = (msgId) => {
    updateInlay(activeRoomId, msgId, prev => {
      const elapsed = prev.startedAt ? Math.max(0, Math.floor((Date.now() - prev.startedAt) / 1000)) : 0;
      const anyJoined = prev.participants.some(p => p.conn === "joined" || p.conn === "self");
      return {
        ...prev,
        state: anyJoined ? "ended" : "missed",
        duration: anyJoined ? elapsed : null,
        endedAtLabel: nowTime(),
      };
    });
  };

  const onCallJoin = (msgId) => {
    updateInlay(activeRoomId, msgId, prev => ({
      ...prev,
      state: "active",
      startedAt: prev.startedAt ?? Date.now(),
      participants: prev.participants.find(p => p.id === "u_me")
        ? prev.participants.map(p => p.id === "u_me" ? { ...p, conn: "self" } : p)
        : [...prev.participants, { id: "u_me", conn: "self", muted: false, talking: true }],
    }));
  };

  /* ============ VIDEO handlers (live feed + watch party) ============ */
  const onVideoUpdate = (msgId, action) => {
    /* locate the room holding this inlay (active room in practice) */
    let roomId = activeRoomId;
    for (const r of rooms) {
      if (r.messages.some(m => m.id === msgId && m.inlay?.kind === "video")) { roomId = r.id; break; }
    }
    if (action.snapshot) {
      showToast("Snapshot saved to #garden");
      return;
    }
    updateInlay(roomId, msgId, prev => {
      const running = prev.state === "live" || prev.state === "playing";
      const liveState = prev.mode === "live" ? "live" : "playing";
      const elapsedBase = () => (prev.posSec || 0) + (prev.clockAt ? Math.floor((Date.now() - prev.clockAt) / 1000) : 0);
      if (action.toggle) {
        return running
          ? { ...prev, state: "paused", posSec: Math.min(elapsedBase(), prev.durationSec ?? Infinity), clockAt: null }
          : { ...prev, state: liveState, clockAt: Date.now() };
      }
      if (action.seek != null) {
        return { ...prev, posSec: action.seek, clockAt: running ? Date.now() : null };
      }
      if (action.toggleMute) return { ...prev, muted: !prev.muted };
      if (action.stop) {
        return { ...prev, state: "ended", posSec: Math.min(elapsedBase(), prev.durationSec ?? Infinity), clockAt: null };
      }
      if (action.restart) {
        return { ...prev, state: liveState, posSec: 0, clockAt: Date.now() };
      }
      return prev;
    });
  };

  const onAddTask = ({ title, priority, when }) => {
    const id = "t_" + Math.random().toString(36).slice(2, 7);
    setTasks(prev => [...prev, { id, title, state: "queued", priority, when }]);
    setShowAddTask(false);

    /* echo into garden room as a system note */
    const echoId = "m_" + Math.random().toString(36).slice(2, 9);
    setRoomsState(prev => ({
      ...prev,
      r_garden: {
        ...prev.r_garden,
        messages: [...prev.r_garden.messages, {
          id: echoId, t: nowTime(), from: "u_me",
          text: `Queued for the agent: "${title}" (${priority} priority).`,
          state: "sent", transport: transportLabel,
        }]
      }
    }));

    /* after a moment, move the new task to running */
    setTimeout(() => {
      setTasks(prev => prev.map(tt => tt.id === id ? { ...tt, state: "running", progress: 0.04 } : tt));
    }, 1400);
  };

  const onSlash = (cmd) => {
    if (cmd.startsWith("/task")) {
      if (activeRoomId === "r_garden") setShowAddTask(true);
      else alert("/task is available in rooms with an agent.");
    } else if (cmd === "/field") {
      setTransportMode("FIELD");
    } else if (cmd === "/home") {
      setTransportMode("AUTO");
    } else if (cmd === "/call") {
      onStartCall();
    } else if (cmd === "/poll") {
      /* drop a starter poll */
      const id = "m_" + Math.random().toString(36).slice(2, 9);
      setRoomsState(prev => ({
        ...prev,
        [activeRoomId]: {
          ...prev[activeRoomId],
          messages: [...prev[activeRoomId].messages, {
            id, t: nowTime(), from: "u_me",
            inlay: {
              kind: "poll",
              question: "New poll — edit the question",
              options: [
                { id: "p1", label: "Option one", votes: 0 },
                { id: "p2", label: "Option two", votes: 0 },
              ],
            }
          }]
        }
      }));
    }
  };

  const showPanel = activeRoom?.kind === "agent-room" && activeRoom.members.includes("a_garden");
  const panelShowing = showPanel && t.panelPlacement === "sidebar" && sidebarOpen;

  /* find any active/ringing call across all rooms — for the global call bar */
  const activeCall = (() => {
    for (const r of rooms) {
      for (const m of r.messages) {
        if (m.inlay && m.inlay.kind === "call" && (m.inlay.state === "active" || m.inlay.state === "ringing")) {
          return { roomId: r.id, room: r, msg: m, inlay: m.inlay };
        }
      }
    }
    return null;
  })();

  /* Tweak handlers */
  const tweakKey = (key, val) => setTweak(key, val);

  return (
    <>
      <div
        className="shell"
        data-panel={t.panelPlacement}
        data-has-panel={panelShowing ? "true" : "false"}
        data-mobile-view={isMobile ? mobileView : undefined}
        data-sidebar-open={panelShowing ? "true" : "false"}
      >
        <SpaceRail
          spaces={spaces}
          active={activeSpace}
          onPick={setActiveSpace}
          mobile={isMobile}
          onSwitchView={setMobileView}
          onCreateSpace={() => setShowCreateSpace(true)}
        />
        <RoomList
          space={activeSpace}
          spaces={spaces}
          rooms={rooms}
          activeRoom={activeRoomId}
          onPick={setActiveRoomId}
          mobile={isMobile}
          onSwitchView={setMobileView}
          transportMode={transportMode}
          setTransportMode={setTransportMode}
          onCreateChannel={(spaceId) => setCreateChannelFor(spaceId)}
        />

        {activeRoom ? (
          <section className={"room" + (activeRoom.xh ? " xh" : "")}>
            <RoomHeader
              room={activeRoom}
              onBack={() => setMobileView("rooms")}
              onStartCall={onStartCall}
              onOpenMembers={() => setShowMembers(true)}
              onOpenSettings={() => setShowSettings(true)}
              onMute={() => showToast("Muted notifications for this room")}
              onPin={() => showToast("Pinned to the top of its space")}
              onMarkRead={() => showToast("All messages marked as read")}
              onArchive={() => showToast("Room archived — find it under Settings → Archived")}
              onLeave={() => showToast("You can only leave non-owner rooms (demo)")}
              onOpenAudit={() => setShowAudit(true)}
              hasSidebar={showPanel && t.panelPlacement === "sidebar"}
              sidebarVisible={sidebarOpen}
              onToggleSidebar={() => setSidebarOpen(v => !v)}
            />

            {/* Global call bar — visible whenever any room has a live call */}
            {activeCall && (
              <window.GlobalCallBar
                call={activeCall}
                isHere={activeCall.roomId === activeRoomId}
                onJump={() => setActiveRoomId(activeCall.roomId)}
                onToggleMute={() => onCallUpdate(activeCall.msg.id, { toggleMute: true })}
                onEnd={() => onCallEnd(activeCall.msg.id)}
              />
            )}
            {activeRoom.xh && (
              <div className="xh-banner">
                <Icon name="info" size={14}/>
                <span>This room contains people from another household. Outside members are marked.</span>
              </div>
            )}

            {/* When panel is in header-strip mode, render compact panel above body */}
            {showPanel && t.panelPlacement === "header" && (
              <div className="room-panel">
                <AgentPanel
                  agentId="a_garden"
                  tasks={tasks}
                  onAddTask={() => setShowAddTask(true)}
                  onConfigure={() => alert("Configure (modal — wire up later)")}
                  onLogs={() => setShowAudit(true)}
                  collapsed={cardCollapsed.agent}
                  onToggleCollapse={() => toggleCard("agent")}
                />
              </div>
            )}

            <div className="room-body" ref={bodyRef}>
              <div className="day-divider">Today · {new Date().toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}</div>
              {activeRoom.messages.map((m, i) => {
                const prev = activeRoom.messages[i - 1];
                const dense = prev && !prev.system && !m.system
                  && prev.from === m.from && !m.inlay && !prev.inlay
                  && !m.replyTo && !m.quote && (timeGapOk(prev.t, m.t));
                const replyToMsg = m.replyTo ? activeRoom.messages.find(x => x.id === m.replyTo) : null;
                return (
                  <Message
                    key={m.id}
                    msg={m}
                    dense={dense}
                    transportHint={m.transport}
                    replyToMsg={replyToMsg}
                    isEditing={editingId === m.id}
                    onReact={onReact}
                    onReply={onReply}
                    onQuote={onQuote}
                    onCopy={onCopy}
                    onStartEdit={onStartEdit}
                    onSaveEdit={onSaveEdit}
                    onCancelEdit={onCancelEdit}
                    onDelete={onDelete}
                    onJumpTo={onJumpTo}
                    InlayRenderer={(p) => (
                      <InlayRenderer {...p}
                        onPollVote={onPollVote}
                        onApproval={onApproval}
                        onViewDetails={setDetailsMsgId}
                        onCallUpdate={onCallUpdate}
                        onCallEnd={onCallEnd}
                        onCallJoin={onCallJoin}
                        onSuggestionAdd={onSuggestionAdd}
                        onVideoUpdate={onVideoUpdate}
                        onVideoExpand={setVideoTheaterMsgId}
                      />
                    )}
                  />
                );
              })}
              <div style={{ height: 12 }}/>
            </div>

            <Composer
              room={activeRoom}
              transportMode={transportMode}
              onSend={sendMessage}
              onSlash={onSlash}
              replyTo={composerCtx?.kind === "reply" ? activeRoom.messages.find(m => m.id === composerCtx.msgId) : null}
              quote={composerCtx?.kind === "quote" ? composerCtx.quote : null}
              onClearContext={() => setComposerCtx(null)}
            />
          </section>
        ) : (
          <Welcome/>
        )}

        {/* Sidebar panel — sibling of .room inside .shell */}
        {showPanel && t.panelPlacement === "sidebar" && activeRoom && sidebarOpen && (
          <aside className="room-panel">
            <AgentPanel
              agentId="a_garden"
              tasks={tasks}
              onAddTask={() => setShowAddTask(true)}
              onConfigure={() => alert("Configure (modal — wire up later)")}
              onLogs={() => setShowAudit(true)}
              collapsed={cardCollapsed.agent}
              onToggleCollapse={() => toggleCard("agent")}
            />
            <CapabilitiesCard
              collapsed={cardCollapsed.capabilities}
              onToggleCollapse={() => toggleCard("capabilities")}
              onOpenAudit={() => setShowAudit(true)}
            />
          </aside>
        )}
        {/* Mobile drawer scrim */}
        {showPanel && t.panelPlacement === "sidebar" && sidebarOpen && isMobile && (
          <div className="sidebar-scrim" onClick={() => setSidebarOpen(false)}/>
        )}
      </div>

      {showAddTask && (
        <AddTaskModal
          agentId="a_garden"
          onClose={() => setShowAddTask(false)}
          onSubmit={onAddTask}
        />
      )}

      {showMembers && activeRoom && (
        <window.MembersModal
          room={activeRoom}
          onClose={() => setShowMembers(false)}
          onOpenAudit={() => { setShowMembers(false); setShowAudit(true); }}
        />
      )}

      {showSettings && activeRoom && (
        <window.RoomSettingsModal
          room={activeRoom}
          onClose={() => setShowSettings(false)}
        />
      )}

      {showAudit && activeRoom && (
        <window.AuditLogModal
          room={activeRoom}
          onClose={() => setShowAudit(false)}
        />
      )}

      {showCreateSpace && (
        <window.CreateSpaceModal
          onClose={() => setShowCreateSpace(false)}
          onSubmit={onCreateSpace}
          existingShorts={spaces.map(s => s.short)}
        />
      )}

      {createChannelFor && (
        <window.CreateChannelModal
          defaultSpaceId={createChannelFor}
          spaces={spaces}
          existingNames={rooms.filter(r => r.space === createChannelFor).map(r => r.name)}
          onClose={() => setCreateChannelFor(null)}
          onSubmit={onCreateChannel}
        />
      )}

      {toast && (
        <div className="cairn-toast" role="status">
          <Icon name="check" size={12}/>
          <span>{toast}</span>
        </div>
      )}

      {detailsMsgId && (() => {
        /* locate the inlay across rooms */
        let foundMsg = null;
        let foundRoomId = null;
        for (const r of rooms) {
          const m = r.messages.find(mm => mm.id === detailsMsgId && mm.inlay);
          if (m) { foundMsg = m; foundRoomId = r.id; break; }
        }
        if (!foundMsg) return null;

        const close = () => setDetailsMsgId(null);
        const inlay = foundMsg.inlay;

        if (inlay.kind === "approval") {
          return (
            <ApprovalDetailsModal
              inlay={inlay}
              fromId={foundMsg.from}
              onClose={close}
              onResolve={(decision) => {
                setRoomsState(prev => ({
                  ...prev,
                  [foundRoomId]: {
                    ...prev[foundRoomId],
                    messages: prev[foundRoomId].messages.map(mm =>
                      mm.id === foundMsg.id && mm.inlay?.kind === "approval"
                        ? { ...mm, inlay: { ...mm.inlay, state: decision } }
                        : mm
                    )
                  }
                }));
              }}
            />
          );
        }
        if (inlay.kind === "poll") {
          return (
            <window.PollDetailsModal
              inlay={inlay}
              fromId={foundMsg.from}
              onClose={close}
              onVote={(optId) => onPollVoteIn(foundRoomId, foundMsg.id, optId)}
            />
          );
        }
        if (inlay.kind === "task-card") {
          return (
            <window.TaskDetailsModal
              inlay={inlay}
              fromId={foundMsg.from}
              onClose={close}
            />
          );
        }
        if (inlay.kind === "call") {
          return (
            <window.CallDetailsModal
              inlay={inlay}
              fromId={foundMsg.from}
              onClose={close}
            />
          );
        }
        if (inlay.kind === "video") {
          return (
            <window.VideoDetailsModal
              inlay={inlay}
              msgId={foundMsg.id}
              fromId={foundMsg.from}
              onClose={close}
              onUpdate={onVideoUpdate}
            />
          );
        }
        return null;
      })()}

      {videoTheaterMsgId && (() => {
        let foundMsg = null;
        for (const r of rooms) {
          const m = r.messages.find(mm => mm.id === videoTheaterMsgId && mm.inlay?.kind === "video");
          if (m) { foundMsg = m; break; }
        }
        if (!foundMsg) return null;
        return (
          <window.VideoTheater
            inlay={foundMsg.inlay}
            msgId={foundMsg.id}
            fromId={foundMsg.from}
            onClose={() => setVideoTheaterMsgId(null)}
            onUpdate={onVideoUpdate}
          />
        );
      })()}

      {/* ----- Tweaks ----- */}
      <TweaksPanel title="Tweaks">
        <TweakSection label="Appearance">
          <TweakRadio
            label="Theme"
            value={t.theme}
            options={[
              { value: "light", label: "Light" },
              { value: "dark",  label: "Dark"  },
            ]}
            onChange={(v) => tweakKey("theme", v)}
          />
          <TweakRadio
            label="Agent panel placement"
            value={t.panelPlacement}
            options={[
              { value: "sidebar", label: "Sidebar"      },
              { value: "header",  label: "Header strip" },
            ]}
            onChange={(v) => tweakKey("panelPlacement", v)}
          />
        </TweakSection>
        <TweakSection label="Try it">
          <div style={{ fontSize: 12, color: "var(--text-3)", lineHeight: 1.5, fontFamily: "var(--font-sans)" }}>
            <p style={{ margin: "0 0 6px" }}>• Click a room. Try the <b>Ops</b> room → approve or deny the capability.</p>
            <p style={{ margin: "0 0 6px" }}>• In the <b>family</b> room, vote in the poll.</p>
            <p style={{ margin: "0 0 6px" }}>• In <b>garden</b>, click <b>Add task</b> or type <code style={{ fontFamily: "var(--font-mono)" }}>/task</code>.</p>
            <p style={{ margin: "0 0 6px" }}>• Send a message — watch the <i>sending → sent → delivered</i> states.</p>
            <p style={{ margin: 0 }}>• Cycle the transport pill (bottom-left) to <code style={{ fontFamily: "var(--font-mono)" }}>FIELD</code> — the composer flips to <i>via mesh</i>.</p>
          </div>
        </TweakSection>
      </TweaksPanel>
    </>
  );
};

/* ---- Welcome screen (no room selected) ---- */
const Welcome = () => (
  <div className="welcome">
    <div className="card">
      <div className="mark">
        <svg width="30" height="30" viewBox="0 0 26 26" fill="none">
          <rect x="6"  y="14.5" width="14" height="4"  rx="1.2" fill="var(--text)"/>
          <rect x="8"  y="9.5"  width="10" height="3.5" rx="1"  fill="var(--text-2)"/>
          <rect x="10" y="5.5"  width="6"  height="3"   rx="0.8" fill="var(--accent)"/>
        </svg>
      </div>
      <h1>Cairn</h1>
      <p>Pick a room to start. Everything routes locally first — internet, mesh, Bluetooth, whatever's there.</p>
    </div>
  </div>
);

/* ---- helpers ---- */
function nowTime() {
  const d = new Date();
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}
function timeGapOk(prev, next) {
  if (!prev || !next) return false;
  if (prev.includes(" ") || next.includes(" ")) return false; /* day-prefixed times — don't group */
  const [ph, pm] = prev.split(":").map(Number);
  const [nh, nm] = next.split(":").map(Number);
  if (Number.isNaN(ph) || Number.isNaN(nh)) return false;
  return (nh * 60 + nm) - (ph * 60 + pm) <= 3;
}

ReactDOM.createRoot(document.getElementById("root")).render(<App/>);
