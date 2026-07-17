/* Sample data: households, identities, spaces, rooms, members, messages, inlays */

const ME = { id: "u_me", kind: "human", name: "Aaron", initials: "AR", color: "var(--accent)" };

const PEOPLE = {
  u_me:      ME,
  u_mira:    { id: "u_mira",   kind: "human", name: "Mira",     initials: "MR", color: "oklch(0.62 0.10 35)" },
  u_jules:   { id: "u_jules",  kind: "human", name: "Jules",    initials: "JL", color: "oklch(0.58 0.10 290)" },
  u_kai:     { id: "u_kai",    kind: "human", name: "Kai",      initials: "KA", color: "oklch(0.60 0.10 160)" },
  u_priya:   { id: "u_priya",  kind: "human", name: "Priya",    initials: "PR", color: "oklch(0.62 0.10 60)" },
  u_sam:     { id: "u_sam",    kind: "human", name: "Sam",      initials: "SM", color: "oklch(0.58 0.10 210)", origin: "sister's household" },
  a_garden:  { id: "a_garden", kind: "agent", name: "Garden",   short: "GR",   op: "Aaron"   },
  a_house:   { id: "a_house",  kind: "agent", name: "House",    short: "HS",   op: "Aaron"   },
  a_ops:     { id: "a_ops",    kind: "agent", name: "Ops",      short: "OP",   op: "Aaron"   },
  a_reels:   { id: "a_reels",  kind: "agent", name: "Reels",    short: "RL",   op: "Mira"    },
};

const SPACES = [
  { id: "sp_family", short: "FA", name: "Family",       hasUnread: true  },
  { id: "sp_home",   short: "HM", name: "Home",         hasUnread: false },
  { id: "sp_ops",    short: "OP", name: "Ops",          hasUnread: true  },
  { id: "sp_nbr",    short: "NB", name: "Neighborhood", hasUnread: false },
];

const ROOMS = [
  /* ---- garden agent room ---- */
  {
    id: "r_garden", space: "sp_home", name: "garden", glyph: "#",
    kind: "agent-room",
    members: ["u_me", "u_mira", "a_garden"],
    subtitle: "3 members · Garden agent reachable",
    transport: "lan",
    unread: 0,
    messages: [
      { id: "m1", t: "09:14", from: "u_mira", text: "Beds 8 and 9 looked dry yesterday. Can you check?", reactions: [{ emoji: "👀", by: ["u_me"] }] },
      { id: "m2", t: "09:14", from: "u_me",   text: "On it — let me ask the agent to peek.", replyTo: "m1" },
      { id: "m3", t: "09:15", from: "a_garden", inlay: {
        kind: "task-card", title: "Inspect bed 7 — done",
        sub: "ran 6 min · soil 22% — within range",
        detail: {
          requestedBy: "u_mira",
          startedAt:   "09:08",
          endedAt:     "09:14",
          durationSec: 372,
          capabilities: [
            { name: "sensor.read(soil_moisture)", scope: "bed_7" },
            { name: "sensor.read(soil_temp)",     scope: "bed_7" },
          ],
          steps: [
            { t: "09:08", label: "Acquired one-shot read grants for bed 7 sensors." },
            { t: "09:09", label: "Sampled soil moisture and soil temperature (3-sample average)." },
            { t: "09:12", label: "Cross-checked against the last 24h rolling baseline." },
            { t: "09:14", label: "Released grants and posted task-complete card to #garden." },
          ],
          readings: [
            { k: "Soil moisture",   v: "22%",   note: "within 18–28% range" },
            { k: "Soil temp",       v: "16.4°C", note: "+0.2°C from yesterday" },
            { k: "Last irrigation", v: "23h ago", note: "8-min cycle, bed 7" },
            { k: "Next check",      v: "tomorrow 09:00" },
          ],
          notes: "No action recommended. Bed 7 is within the normal moisture band and trending stable.",
        }
      }},
      { id: "m4", t: "13:42", from: "u_me", text: "What's the forecast looking like for irrigation today?", edited: true },
      { id: "m5", t: "13:43", from: "a_garden", text: "Light cloud cover until 4pm; soil at beds 1–6 still moist from yesterday. I queued bed 3 (driest) for a 12-min cycle.", replyTo: "m4", reactions: [{ emoji: "🙏", by: ["u_me"] }, { emoji: "✅", by: ["u_mira"] }] },
      { id: "m6", t: "13:45", from: "u_mira", text: "Can I actually see bed 3 before the cycle runs?" },
      { id: "m7", t: "13:45", from: "a_garden", text: "Opening a live view — view-only, nothing's recorded.", replyTo: "m6" },
      { id: "m8", t: "13:46", from: "a_garden", inlay: {
        kind: "video", mode: "live",
        title: "Garden cam · bed 3",
        camera: "cam_bed3",
        location: "East beds · row 3",
        capability: "camera.stream(cam_bed3)",
        resolution: "1080p", fps: 24,
        audio: true, muted: true,
        state: "live",
        posSec: 38, clockAt: Date.now(),
        openedAt: "13:46",
        host: "a_garden",
        watchers: ["u_me", "u_mira"],
        provenance: [
          { icon: "leaf",   text: "Bed-3 soil moisture dropped to <b>12%</b> — a 12-min cycle is queued.", t: "13:42" },
          { icon: "person", text: "<b>Mira</b> asked to see the bed before water runs.", t: "13:45" },
          { icon: "eye",    text: "Garden opened a <b>view-only</b> camera stream — frames only, no recording.", t: "13:46" },
        ],
      }},
      { id: "m9", t: "13:52", from: "a_garden", text: "Posting the greenhouse bench readings — pinned so you can watch them update." },
      { id: "m10", t: "13:52", from: "a_garden", inlay: {
        kind: "greenhouse",
        state: "loading",
        title: "Greenhouse — east bench",
        updatedMins: 0, updatedAbs: "13:52",
        status: { label: "nominal", polarity: "positive", icon: "check" },
        readings: [
          { k: "Air temp",      n: 24.6, unit: "°C",  delta: 0.2, trend: "up",   note: "within 22–26° band", live: true, step: 0.4 },
          { k: "Humidity",      n: 61,   unit: "%",   delta: 1,   trend: "down", note: "target 55–70%",       live: true, step: 1.2 },
          { k: "Soil moisture", n: 34,   unit: "%",   delta: 0,   trend: "flat", note: "beds nominal",        live: true, step: 0.6 },
          { k: "CO₂",           n: 640,  unit: "ppm", delta: 8,   trend: "up",   note: "day cycle",           live: true, step: 12 },
        ],
        seriesLabel: "Air temp · last 6h",
        series: [23.1, 23.4, 23.2, 23.8, 24.2, 24.0, 24.5, 24.3, 24.6, 24.4, 24.6, 24.5],
        seriesBand: [22, 26],
        capAction: { label: "Open roof vent", capability: "vent.actuate(gh_roof)", scope: "30 min · this vent only" },
        fallback: "Greenhouse east bench — 24.6°C, 61% humidity, soil 34%, CO₂ 640ppm. Nominal.",
      }},
      { id: "m11", t: "13:53", from: "a_garden", inlay: {
        kind: "greenhouse",
        state: "error",
        title: "Greenhouse — west bench",
        fallback: "Greenhouse west bench — last known 23.9°C, soil 29%.",
      }},
      { id: "m12", t: "13:55", from: "a_garden", text: "The full climate dashboard is a widget — it won't run inline, tap Open to launch it sandboxed." },
      { id: "m13", t: "13:55", from: "a_garden", inlay: {
        kind: "widget",
        title: "Climate control dashboard",
        sub: "live · 8 sensors · 2 actuators",
        icon: "monitor",
        tone: "oklch(0.5 0.09 155)", tone2: "oklch(0.36 0.07 175)",
        fallback: "Interactive climate dashboard: vent, misting and heater schedules for the greenhouse.",
      }},
    ],
  },

  /* ---- ops room with approval ---- */
  {
    id: "r_ops", space: "sp_ops", name: "ops", glyph: "#",
    kind: "agent-room",
    members: ["u_me", "a_garden", "a_ops"],
    subtitle: "3 members · 2 agents · auto-mute presence",
    transport: "lan",
    unread: 1,
    messages: [
      { id: "o1", t: "08:30", from: "a_ops", text: "Nightly backup completed at 03:14. Snapshot ID `op-snap-0524-03`." },
      { id: "o2", t: "13:58", from: "a_garden", text: "Bed 3 moisture has dropped below threshold (12%). Recommending a short irrigation cycle." },
      { id: "o3", t: "14:02", from: "a_garden", inlay: {
        kind: "approval",
        title: "Garden agent requests approval",
        capability: "valve.actuate(bed_3)",
        scope: "1 hour · this actuator only · auto-revoked at 15:02",
        requestedAt: "14:02",
        expiresAt: "14:30",
        state: "pending",
      }},
    ],
  },

  /* ---- family group chat with poll ---- */
  {
    id: "r_family", space: "sp_family", name: "family", glyph: "#",
    kind: "group",
    members: ["u_me", "u_mira", "u_jules", "u_kai", "a_reels"],
    subtitle: "5 members · Reels agent reachable",
    transport: "lan",
    unread: 2,
    messages: [
      { id: "f1", t: "18:02", from: "u_mira",  text: "Movie night?" },
      { id: "f2", t: "18:03", from: "u_jules", text: "Yes please. Something not too long.", reactions: [{ emoji: "👍", by: ["u_mira", "u_kai"] }] },
      { id: "f3", t: "18:04", from: "u_kai",   text: "Already in pajamas, can confirm.", replyTo: "f2", reactions: [{ emoji: "😂", by: ["u_mira", "u_jules", "u_me"] }, { emoji: "🛋️", by: ["u_jules"] }] },
      { id: "f4", t: "18:05", from: "u_mira",  inlay: {
        kind: "poll",
        question: "Movie tonight?",
        createdBy: "u_mira",
        createdAt: "18:05",
        options: [
          { id: "p1", label: "Dune: Part Two",  votes: 2, voters: ["u_jules", "u_kai"] },
          { id: "p2", label: "Spirited Away",   votes: 1, voters: ["u_mira"] },
          { id: "p3", label: "Skip it",         votes: 0, voters: [] },
        ],
        activity: [
          { t: "18:05", who: "u_mira",  what: "created the poll" },
          { t: "18:06", who: "u_jules", what: "voted for Dune: Part Two" },
          { t: "18:08", who: "u_kai",   what: "voted for Dune: Part Two" },
          { t: "18:10", who: "u_mira",  what: "voted for Spirited Away" },
        ],
        closesAt: "20:00",
      }},
      { id: "f5", t: "18:08", from: "u_kai",   text: "Voted 🌀" },
      { id: "f6", t: "18:11", from: "u_me",    text: "Setting expectations:", quote: { fromId: "u_kai", text: "Already in pajamas, can confirm.", t: "18:04", srcId: "f3" }, reactions: [{ emoji: "😂", by: ["u_mira", "u_kai"] }] },
      { id: "f7", t: "18:12", from: "u_me",    text: "If we don't start by 8:30 I'm out cold.", state: "delivered" },
      { id: "f8", t: "18:14", from: "u_jules", text: "Honestly… Dune again? Anything we haven't already seen?", reactions: [{ emoji: "🤔", by: ["u_mira"] }] },
      { id: "f9", t: "18:15", from: "u_mira",  text: "Let me ask Reels. Adding her now." },
      { id: "f10", t: "18:15", system: true, kind: "member-add", actorId: "u_mira", targetId: "a_reels", room: "family" },
      { id: "f11", t: "18:15", from: "a_reels", text: "Joining. I can see the poll's leaning Dune. Want me to pitch three short ones that aren't on it?" },
      { id: "f12", t: "18:16", from: "u_jules", text: "Yes please. Under two hours.", replyTo: "f11" },
      { id: "f13", t: "18:16", from: "a_reels", text: "On it — three recent picks, all under 110 minutes:" },
      { id: "f14", t: "18:16", from: "a_reels", inlay: {
        kind: "suggestion-list",
        title: "Three short ones, all under 110 min",
        sub: "Recent · highly rated · matches a tired-Tuesday mood",
        targetPollId: "f4",
        items: [
          { id: "sl1", title: "Past Lives",        year: 2023, runtime: 105, tag: "drama · romance",
            why: "Quiet, gorgeous, won't keep anyone up. A24.",
            tone: "oklch(0.55 0.12 30)", tone2: "oklch(0.42 0.10 350)" },
          { id: "sl2", title: "Aftersun",          year: 2022, runtime: 101, tag: "drama",
            why: "Heartbreaker but short. Best on the couch.",
            tone: "oklch(0.60 0.10 220)", tone2: "oklch(0.45 0.12 250)" },
          { id: "sl3", title: "Petite Maman",      year: 2021, runtime: 72,  tag: "drama · fantasy",
            why: "72 minutes. We could be in bed by 10.",
            tone: "oklch(0.65 0.11 140)", tone2: "oklch(0.50 0.10 180)" },
        ],
        added: [],
      }},
      { id: "f15", t: "18:17", from: "u_jules", text: "Petite Maman PLEASE.", reactions: [{ emoji: "🙌", by: ["u_mira"] }] },
      { id: "f16", t: "18:18", from: "u_mira",  text: "Done. Starting it for the room 🍿" },
      { id: "f17", t: "18:18", from: "u_mira",  inlay: {
        kind: "video", mode: "watch",
        title: "Petite Maman",
        year: 2021, tag: "drama · fantasy",
        tone: "oklch(0.65 0.11 140)", tone2: "oklch(0.50 0.10 180)",
        durationSec: 4320,
        source: "household library",
        audio: true, muted: false,
        synced: true,
        state: "playing",
        posSec: 184, clockAt: Date.now(),
        openedAt: "18:18",
        host: "u_mira",
        startedBy: "u_mira",
        watchers: ["u_mira", "u_jules", "u_me"],
        provenance: [
          { icon: "film",  text: "<b>Reels</b> pitched three short films, all under 110 min.", t: "18:16" },
          { icon: "check", text: "<b>Jules</b> picked <b>Petite Maman</b> — 72 minutes.", t: "18:17" },
          { icon: "play",  text: "<b>Mira</b> started a synced watch party for the room.", t: "18:18" },
        ],
      }},
    ],
  },

  /* ---- 1:1 DM ---- */
  {
    id: "r_priya", space: "sp_family", name: "Priya", glyph: "@",
    kind: "dm",
    members: ["u_me", "u_priya"],
    subtitle: "1:1 · reachable via LAN",
    transport: "lan",
    unread: 0,
    messages: [
      { id: "d1", t: "Tue 11:22", from: "u_priya", text: "Did you get the recovery code printout I sent over? The 24-word one." },
      { id: "d2", t: "Tue 11:24", from: "u_me",    text: "Yeah, locked in the deposit box. Verified the first 4 words against the device — matched." },
      { id: "d3", t: "Tue 11:25", from: "u_priya", text: "Good. Don't lose that envelope." },
      { id: "d4", t: "10:48",     from: "u_priya", text: "Lunch tomorrow? The new place by the trailhead." },
    ],
  },

  /* ---- cross-household room ---- */
  {
    id: "r_neighbors", space: "sp_nbr", name: "block-watch", glyph: "#",
    kind: "xh-group",
    xh: true,
    members: ["u_me", "u_mira", "u_sam"],
    subtitle: "3 members · 1 cross-household",
    transport: "mesh",
    unread: 0,
    messages: [
      { id: "n1", t: "07:14", from: "u_sam", text: "Power flickered twice on our side around 6:50. Everything ok over there?" },
      { id: "n2", t: "07:16", from: "u_me",  text: "We're fine — saw the flicker too. Mesh seems stable." },
    ],
  },
];

window.CAIRN = { ME, PEOPLE, SPACES, ROOMS };
