# The approval system and inlays

Two features that sit on top of the event and E2EE machinery
(`events-and-e2ee.md`): **approvals** — how a human authorises an agent to do
something, producing an artifact the agent carries out of Cairn — and **inlays** —
how an agent (or the app) renders rich, interactive UI into a room as data rather
than code.

They are documented together because they meet at one place: an approval request
is the one inlay the client refuses to let anyone redefine.

---

# Part 1 — The approval system

## The problem it solves

An agent wants to do something that needs authority it doesn't have: actuate a
vent, spend from a budget, call an API on your behalf. The decision belongs to a
human, and the *result* of that decision has to be usable **outside Cairn** — by
whatever broker actually mints the credential or performs the action.

Cairn's answer: **portable signed artifacts**. The room is the delivery medium,
not the capability boundary. Cairn carries the request to a human, captures the
human's signature, and hands back an artifact the agent presents elsewhere. Cairn
never mints a credential, never enforces policy, and never keeps a single-use
cache — those are the broker's job (`approval/approval.go:1-18`).

The defining property: every artifact is signed over its **own** canonical bytes,
not the room envelope, so it **verifies standalone** — with no room key, no
identity log, and no Cairn server. A broker that has never heard of Cairn can
check a grant with nothing but the artifact and the approver's public key.

## The opaque-payload model

An approval doesn't hard-code *what* is being approved. It carries an **opaque
`payload`** plus a **`payload_type`** saying how to read it, and binds to it by
**`payload_hash`** (`approval/approval.go:39-63`):

- Cairn moves and witnesses the payload by hash without needing to understand it.
- The broker parses the payload according to its declared type.
- A different system can put its own capability schema's bytes under its own type,
  and ride the same rails.

Cairn ships exactly one payload type:

```
PayloadTypeCapability = "cairn.capability.v1"
```

whose payload is a `Capability` (`approval/approval.go:53-58`):

```go
Name   string            `cbor:"name"`             // e.g. "vent.actuate"
Params map[string]string `cbor:"params,omitempty"` // e.g. {"target": "gh_roof"}
Scope  string            `cbor:"scope,omitempty"`  // human-readable
TaskID string            `cbor:"task_id,omitempty"`
```

`Scope` — the human-readable "Open the greenhouse roof vent for 20 minutes" — lives
**inside** the payload, so it is covered by the hash the approver signs. It is
never a caption displayed alongside an unsigned blob.

`payload_hash` is `BLAKE3-256` over the payload's **exact bytes, hashed as-is and
never re-encoded** (`HashPayload`, `approval/approval.go:60-63`), so the
commitment is byte-stable as the payload travels from request to grant to broker.

## The artifacts

Four signed artifact types, each tagged inside its own signed bytes so a broker
can never read one as another (`approval/approval.go`):

**`Request`** (type `approval_request`, signed by the agent's device key,
`:136-146`) — the ask:

```
request_id, agent_pub, payload_type, payload, payload_hash, issued_at, expires_at, sig
```

`expires_at` is mandatory — nothing parks forever.

**`Grant`** (type `approval_grant`, signed by the **human's** key, `:153-162`) —
the deliverable:

```
request_id, payload_hash, agent_pub, approver_pub, issued_at, expires_at, sig
```

The grant **binds** to `request_id` + `payload_hash` (so it can't be retargeted to
a different action) and to `agent_pub` (so it can't be replayed by a different
agent). It commits to the payload by hash, not value — the payload itself travels
in the request the agent presents alongside.

**`Deny`** (type `approval_deny`, signed by the human, `:166-173`) — a refusal
with an optional reason. A timeout denial is simply the absence of a grant before
`expires_at`.

**`CredentialMinted`** (`:177-181`) — emitted back into the room **by the broker**
after it mints. Cairn only decodes and displays it; it never produces one.

## Signing and standalone verification

`Sign` sets `sig = nil` and forces the canonical `type` tag, then Ed25519-signs
the deterministic-CBOR of the artifact (`approval/approval.go:250-269`). `verify`
checks the tag **first** (rejecting a wrong-shape artifact before any signature
work), then verifies the signature against the relevant key
(`VerifyGrant` → `approver_pub`). Because the signed bytes are wholly
self-contained, verification needs nothing from Cairn — this is what "portable"
means concretely.

`GrantCovers` (`:311-322`) is the structural binding check a broker runs: same
`request_id`, same `payload_hash`, same `agent_pub`. It is pure structure, not
policy — policy is the broker's.

The browser mirrors all of this byte-for-byte (`webapp/src/lib/approval.ts`),
including a subtle but essential detail: `sig` is encoded as CBOR **null** to
match Go's nil `[]byte`, and `omitempty` fields are omitted identically — a hash
mismatch here would make every cross-language grant fail to verify. This is
guarded by `webapp/scripts/identity-conformance.ts`.

## The flow

```
agent ──approval_request(20)──► room
                                  │ human's client renders ApprovalInlay
                                  ▼
human clicks "Approve & sign"  ── signs a Grant with their key, in-page
                                  │
      ◄──approval_grant(21)────── room
agent picks up the grant
      │
      └──carries it OUT──► external broker
                             │ verifies grant standalone
                             │ enforces single-use (consumed-id cache)
                             │ checks policy
                             │ mints an attenuated, time-boxed credential
      ◄──credential_minted(23)── room (broker emits it back)
```

The dividing line is sharp: **Cairn** delivers the request, renders it, captures
the signature, and relays the artifacts. **The broker** — a separate system, not
a Cairn component — verifies, dedupes, applies policy, and mints. Cairn is the
delivery medium, not the capability boundary.

## The approval UI

`ApprovalInlay.svelte` is a **pinned, audited component** — deliberately *not* a
declared inlay (see Part 2 on why). It always shows the capability and scope ("no
silent authorisation"), maps state to colour (approved/minted → positive,
denied → negative, pending → busy), and on a pending request shows the disclosure
"Approving signs a grant with **your key**, here" beside Approve and Deny. After
approval it reads "Signed grant emitted — portable, verifiable outside Cairn."

---

# Part 2 — Inlays

## The idea

An inlay is rich UI rendered into a room — a poll, a task list, an agent's status
panel, a sensor readout. The design constraint is absolute
(`webapp/src/lib/inlay/types.ts:1-12`):

> There is exactly **one** role renderer — fixed, audited code — that maps a
> declaration to themed UI. Declarations are **data** it interprets, never code
> and never pixels. A declaration never ships script, colour, arbitrary targets,
> or markup.

A poll and a greenhouse panel are the same renderer walking different
declarations. Presentation — colour, type, spacing, density, dark mode,
accessibility — belongs entirely to the engine. This is what makes it safe to let
an agent define UI: the worst a malicious declaration can express is a misleading
*layout*, never behaviour.

## Declarations and content addressing

A declaration (`types.ts:60-67`):

```ts
interface Declaration {
  name: string
  version: number
  schema: Node          // the root of the node tree
  actions?: Action[]
  bound_events?: string[]
  authorless?: boolean
}
```

Its identity is its **hash, not its name**: "two declarations both named
task_list are different inlays." The **`decl_cid`** is BLAKE3 over the
declaration's deterministic CBOR (`registry.ts:25-28`) — the same encoder family
as events and identity objects, so Go and the browser derive identical cids
(guarded by the declaration vector in the conformance suites).

## The vocabulary

The `Node` tree (`types.ts:28-45`). **Leaves** carry a value or a `bind` (a dotted
path into the instance's bindings):

- `text` (`emphasis: title|body|note`), `number` (`unit`, `showTrend`),
  `progress_fraction`, `status_enum` (`icon`, `polarity`), `timestamp`,
  `image_cid`, `series` (`band`, `polarity`), `action_ref`, `input`, `select`.

**Structural constructs** compose them:

- `record` (labelled fields in columns), `list` (repeats an item node over an
  array, scoping each row), `group` (header + children), `inlay_ref` (embeds
  another declaration **by cid** — composition by hash).

**Polarity** — `positive | neutral | negative | busy` → `--pos / --neg / --busy /
neutral` — is the renderer's **only** colour decision. Nothing else in a
declaration can influence colour.

## Instances and the mandatory text fallback

An `INLAY` event carries an instance (`types.ts:74-90`):

```ts
interface InlayInstance {
  decl_cid: string
  surface: 'timeline' | 'room_panel'
  bindings?: Record<string, unknown>   // fills the declaration's binds
  text: string                          // MANDATORY fallback
  widget?: WidgetRef
}
```

`text` is required on **every** inlay: "rendering degrades; delivery does not." A
client that can't resolve the declaration, or hasn't been allowed to render it,
still shows a truthful one-line summary. This is the property that made the whole
system debuggable — a missing declaration is one calm line, never a dead spinner
or lost message.

## `inlay_decl`: agent-definable UI

The original design shipped a fixed standard library of cards in the client and
treated novel declarations as an exception. That capped agent UI at whatever the
client happened to compile in. The model was reversed
(see [`adrs/0012`](adrs/0012-agent-definable-inlays.md), and `events-and-e2ee.md` §3):

An `INLAY_DECL` event (type 34) **publishes a declaration into the room**. A
receiver learns it by recomputing BLAKE3 over its deterministic CBOR and
**refusing anything whose bytes disagree** with the cid an instance references
(`learnDeclaration`, `registry.ts:101-117`). No cid rides on the wire — a carried
one could only contradict its own content. This is what lets an agent render UI
the client never shipped: the declaration is data, the renderer is fixed, and
neither the sender nor the carrier can make a `decl_cid` lie.

If an instance arrives before its declaration, it shows its text line and
re-renders once the declaration syncs — the ordering the DAG makes normal.

## Trust by author

Whether a resolved declaration actually *renders* is decided default-deny in three
tiers (`isAllowed`, `registry.ts:144-169`):

1. **The shipped set** — declarations the client ships (see below; approval only).
2. **Allowed in this room** — an admin clicked "Allow in this room" (stored per
   room in localStorage).
3. **Trust by author** — the declaration was published by a **current member of
   this room**.

Tier 3 is what makes agent UI usable without a prompt per layout: an agent
admitted to a room composes freely. And it is **curation, not a security
boundary** — the role renderer accepts no script, markup, or colour, so the worst
a member can declare is a misleading card, which is equally true of the chat text
beside it. Membership is the gate.

The author is the declaration's publisher resolved to their **member root** (§4 of
`events-and-e2ee.md`), matched against the room roster. Because sender resolution
is asynchronous, the fold re-runs when a sender resolves — otherwise a
just-published declaration would be stuck "not allowed" until reload.

## `inlay_update`: checkpoints

An `INLAY_UPDATE` event (type 31) carries `{ target: event_id, state }` and
updates a posted inlay in place. Updates merge into the target's bindings
**cumulatively in timestamp order** — each checkpoint carries only what changed —
and are **author-restricted**: only the instance's original author may update it,
or any member could repaint anyone's progress bar. `text` is never clobbered; only
bindings move.

This is what lets an agent post one job card and advance it — 18% → 41% → … →
100% — instead of spamming the timeline with status lines. The card a room shows
is the agent's live state.

## Surfaces: timeline vs room panel

`surface` decides where an instance lives:

- `timeline` — inline in the message list, like any other event.
- `room_panel` — pinned to a side panel beside the room, out of the timeline.

The distinction is about lifetime, not looks. A status card that scrolled away
behind an afternoon of chat would be useless the moment anyone spoke, so anything
meant to be **currently true** — an agent's status, its capabilities — goes to the
panel. The panel keeps the newest instance per declaration (re-posting replaces
rather than stacks) and tracks `inlay_update` checkpoints the same as the
timeline. The timeline is what happened; the panel is what's true now.

## Widgets: the escape hatch

When the declarative vocabulary genuinely isn't enough, an instance can name a
`widget` (`component_hash`). Widgets are **code, not data**, and therefore the one
thing that stays security-gated. They **never render inline** — the card shows a
placeholder and an "Open" button that runs the component sandboxed in the shell,
"runs only when opened." Allowlisting a *declaration* is curation; allowlisting a
*widget* is security.

## Degradation phases

`InlayCard.svelte` derives one of four phases (`:32-34`):

- **rendered** — declaration resolved and allowed; the card draws, with a footer
  naming it and its cid.
- **error** — declaration unresolvable: one calm line, the mandatory text plus
  "declaration unavailable (cid…)".
- **text** — shown by choice, or when a resolved declaration isn't allowed here
  (with an "Allow in this room" button).
- **widget** — placeholder + Open, never inline.

## Why approval is not a declaration

The client ships exactly **one** declaration — `approval_prompt` — and even that
is a special case. The everyday cards (poll, task_list, agent_panel,
greenhouse_bench) were **moved out of the client** into `cmd/agent`, which
publishes them at runtime like any other agent would, so the demo exercises the
protocol rather than a built-in registry.

Approval is the exception that must not be author-defined. A spoofable "grant
vent.actuate?" card is a phishing surface — if an agent could supply the
declaration for the very prompt asking a human to authorise that agent, it could
shape what the human sees while deciding. So the approval flow is **pinned** and
rendered by the audited `ApprovalInlay.svelte` component (Part 1), not by data
anyone can publish. It stays specific, trackable, and outside the trust-by-author
path entirely.

That is the whole design in one contrast: agent-definable UI is the general case,
and the shipped set is reserved for flows that must never be author-defined.
