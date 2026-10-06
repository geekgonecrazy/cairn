// Sender directory: resolves a sender pubkey to a self-attested display name by
// fetching its identity-log chain and verifying it locally.
//
// The server is a carrier, not an authority — it hands back signed objects and we
// check every signature here. A name is shown once the chain verifies and the
// member's self-attestation checks out; trust in that key is an edge decision
// (docs §Trust model v2), and verification tiers arrive with the relay directory.

import { cairn, hex } from './api'
import {
  verifyAttestation,
  verifyAgentDelegation,
  vouchWithdrawn,
  samePub,
  TYPE_SESSION_DELEGATION,
  TYPE_DEVICE_DELEGATION,
  TYPE_DEVICE_REVOKE,
  type IdentityAttestation,
  type DeviceDelegation,
  type DeviceRevoke,
  type SessionDelegation,
  type AgentDelegation,
  type VouchWithdraw,
} from './identity'
import { decode as cborDecode } from './cbor'
import { ed25519 } from '@noble/curves/ed25519.js'
import { encode as cborEncode, type CborValue } from './cbor'

/** Mirrors identity.MaxChainDepth in Go. A chain longer than this is refused
 *  rather than walked — it is attacker-supplied data. */
const MAX_CHAIN_DEPTH = 8

export type SenderTrust =
  | { state: 'unknown' } // not resolved yet, or the server has no chain for it
  | {
      state: 'verified'
      name: string
      memberPub: Uint8Array
      kind: string // attested kind: 'human' | 'agent' | 'service'
      /** For agents: the attested operator, proven only when agentProven. */
      operatorPub?: Uint8Array
      /** For agents: whether ≥1 vouch from the operator's tree survives.
       *  An unverified-operator agent still resolves — this is the honest
       *  state, not an error — and callers render it as such. */
      agentProven?: boolean
    }
  | { state: 'revoked'; name: string }

function verifyDetached(
  obj: Record<string, unknown>,
  signerPub: Uint8Array,
  tag: string,
): boolean {
  // The tag is checked FIRST, mirroring identity.ts verifyObject: an object
  // decoded as the wrong shape is rejected before any signature work, so a
  // session delegation can never verify as a device delegation or vice versa.
  if (obj.type !== tag) return false
  const sig = obj.sig as Uint8Array | null
  if (!sig || sig.length !== 64 || !signerPub || signerPub.length !== 32) return false
  try {
    return ed25519.verify(sig, cborEncode({ ...obj, sig: null } as CborValue), signerPub)
  } catch {
    return false
  }
}

const dec = <T>(b: Uint8Array | undefined): T | null => {
  if (!b || b.length === 0) return null
  try {
    return cborDecode(b) as T
  } catch {
    return null
  }
}

class Directory {
  /** senderPubHex → trust state. Reactive so message rows re-render on resolve. */
  private entries = $state<Record<string, SenderTrust>>({})
  /** In-flight resolutions, kept as promises so resolveAwait can join one. */
  private inflight = new Map<string, Promise<void>>()

  /** Called whenever a sender finishes resolving, so folds that depend on
   *  identity can re-run. Sender resolution is async and arrives after the fold
   *  that needed it; without this, anything decided from a member root (names,
   *  and trust-by-author for published declarations) is frozen at whatever was
   *  known on first paint. */
  private listeners: (() => void)[] = []

  onResolved(fn: () => void) {
    this.listeners.push(fn)
  }

  private announce() {
    for (const fn of this.listeners) fn()
  }

  get(senderPubHex: string): SenderTrust {
    return this.entries[senderPubHex] ?? { state: 'unknown' }
  }

  /** Resolve a sender if we haven't already. Safe to call on every render. */
  resolve(senderPub: Uint8Array) {
    void this.start(senderPub)
  }
  /**
   * Resolve and WAIT for the answer.
   *
   * Fire-and-forget is right for rendering a name: the row shows an honest key
   * stub and improves when resolution lands, because `entries` is reactive. It
   * is WRONG when a fold depends on the answer. A declaration's author decides
   * whether it may render (trust-by-author), the fold reads this map
   * synchronously, and nothing re-folds on resolve — so the declaration would be
   * permanently authorless and every agent-published card would degrade to its
   * text line.
   */
  async resolveAwait(senderPub: Uint8Array, proofStack?: Set<string>): Promise<SenderTrust> {
    await this.start(senderPub, proofStack)
    return this.get(hex(senderPub))
  }

  private start(senderPub: Uint8Array, proofStack?: Set<string>): Promise<void> {
    const key = hex(senderPub)
    if (this.entries[key]) return Promise.resolve()
    const existing = this.inflight.get(key)
    if (existing) return existing
    const p = this.fetch(senderPub, key, proofStack).finally(() => this.inflight.delete(key))
    this.inflight.set(key, p)
    return p
  }

  private async fetch(senderPub: Uint8Array, key: string, proofStack?: Set<string>) {
    let res
    try {
      res = await cairn.resolveSender({ senderPub })
    } catch {
      return // offline or unknown; stays 'unknown' and retries on next load
    }

    const att = dec<IdentityAttestation>(res.attestation)
    const sd = dec<SessionDelegation>(res.sessionDelegation)
    const chain = (res.deviceDelegations ?? [])
      .map((b) => dec<DeviceDelegation>(b))
      .filter((d): d is DeviceDelegation => d !== null)
    const revokes = (res.deviceRevokes ?? [])
      .map((b) => dec<DeviceRevoke>(b))
      .filter((d): d is DeviceRevoke => d !== null)
    const vouches = (res.agentDelegations ?? [])
      .map((b) => dec<AgentDelegation>(b))
      .filter((d): d is AgentDelegation => d !== null)
    const withdraws = (res.vouchWithdraws ?? [])
      .map((b) => dec<VouchWithdraw>(b))
      .filter((d): d is VouchWithdraw => d !== null)

    // Walk the chain ourselves: session → device → … → device → member root.
    // Devices pair devices, so the device segment is a WALK; every hop is checked
    // and a break anywhere means we show no name.
    let devicePub = senderPub
    if (sd) {
      if (!verifyDetached(sd as unknown as Record<string, unknown>, sd.device_pub, TYPE_SESSION_DELEGATION)) {
        return
      }
      if (hex(sd.session_pub) !== key) return
      if (sd.expires_at !== 0n && BigInt(Date.now()) > sd.expires_at) return
      devicePub = sd.device_pub
    }

    // The server returns the chain leaf-first, but we re-derive the order from
    // the delegations themselves rather than trusting the array order — the
    // server is a carrier, and a reordered array must not change who we trust.
    const byDevice = new Map(chain.map((d) => [hex(d.device_pub), d]))
    const path: DeviceDelegation[] = []
    const seen = new Set<string>()
    let cur = devicePub
    for (let depth = 0; depth <= MAX_CHAIN_DEPTH; depth++) {
      const curHex = hex(cur)
      if (seen.has(curHex)) return // cycle
      seen.add(curHex)
      const dd = byDevice.get(curHex)
      if (!dd) break // cur is the member root (or the chain is incomplete)
      if (!verifyDetached(dd as unknown as Record<string, unknown>, dd.parent_pub, TYPE_DEVICE_DELEGATION)) {
        return
      }
      if (dd.expires_at !== undefined && dd.expires_at !== 0n && BigInt(Date.now()) > dd.expires_at) {
        return
      }
      path.push(dd)
      if (path.length > MAX_CHAIN_DEPTH) return // too deep
      cur = dd.parent_pub
    }
    if (path.length === 0) return // no delegation for the sending device
    const memberPub = cur

    if (!att || !verifyAttestation(att)) return
    if (hex(att.pubkey) !== hex(memberPub)) return

    // Revocation wins, and is checked at EVERY hop — a revoked ANCESTOR
    // invalidates this sender too, which is what makes revoking a device take
    // down everything paired from it. A revoke binds only when signed by an
    // ancestor of its target; a peer's or a stranger's is ignored, since
    // otherwise anyone could permanently lock out any device.
    for (let i = 0; i < path.length; i++) {
      const target = path[i]
      const dr = revokes.find((r) => hex(r.device_pub) === hex(target.device_pub))
      if (!dr) continue
      if (!verifyDetached(dr as unknown as Record<string, unknown>, dr.revoker_pub, TYPE_DEVICE_REVOKE)) {
        continue
      }
      const ancestors = [...path.slice(i + 1).map((d) => hex(d.device_pub)), hex(memberPub)]
      if (!ancestors.includes(hex(dr.revoker_pub))) continue
      this.entries = { ...this.entries, [key]: { state: 'revoked', name: att.display_name } }
      this.announce()
      return
    }

    // The chain is internally sound and self-attested. v2: trust is decided at
    // the edge (pairing / a shared room), not by a household — so a resolved,
    // non-revoked sender is shown with its self-asserted name. Proper verification
    // tiers (display / relay-vouched / verified petname) arrive with the relay
    // directory (docs §Trust model v2, slice 3).
    //
    // kind is kept, not dropped: callers need it for the agent badge and for
    // admit_kind, and an agent's entry additionally carries its operator proof
    // state (see below) — an unproven agent still resolves, honestly.
    const entry: Extract<SenderTrust, { state: 'verified' }> = {
      state: 'verified',
      name: att.display_name,
      memberPub: att.pubkey,
      kind: att.kind,
    }
    if (att.kind === 'agent' && att.operated_by && att.operated_by.length === 32) {
      entry.operatorPub = att.operated_by
      entry.agentProven = await this.agentProven(att, vouches, withdraws, proofStack)
    }
    this.entries = { ...this.entries, [key]: entry }
    this.announce()
  }

  /**
   * Is this agent's operated_by claim proven — does ≥1 vouch from the
   * operator's tree survive? Mirrors Go's agentVouchProof (identity/agents.go):
   * valid delegator signature, operator match, unexpired, not withdrawn, and a
   * delegator that resolves to the operator (or IS it) and isn't revoked.
   *
   * Each delegator is resolved through the normal path (resolveAwait), so a
   * revoked delegator simply stops proving — revoking one device removes one
   * vouch, never the agent.
   */
  private async agentProven(
    att: IdentityAttestation,
    vouches: AgentDelegation[],
    withdraws: VouchWithdraw[],
    proofStack?: Set<string>,
  ): Promise<boolean> {
    // Cycle guard: a vouch whose proof runs through an agent already being
    // proven up-stack (A vouched by B's device, B vouched by A's) proves
    // nothing. The stack is threaded, not instance state, so concurrent
    // resolutions of the same agent don't false-negative each other.
    const agentHex = hex(att.pubkey)
    if (proofStack?.has(agentHex)) return false
    const stack = proofStack ?? new Set<string>()
    stack.add(agentHex)
    try {
      return await this.proveVouches(att, vouches, withdraws, stack)
    } finally {
      stack.delete(agentHex)
    }
  }

  private async proveVouches(
    att: IdentityAttestation,
    vouches: AgentDelegation[],
    withdraws: VouchWithdraw[],
    stack: Set<string>,
  ): Promise<boolean> {
    const operator = att.operated_by!
    const now = BigInt(Date.now())
    for (const v of vouches) {
      if (!verifyAgentDelegation(v)) continue
      if (!samePub(v.agent_pub, att.pubkey)) continue
      if (!samePub(v.operator_pub, operator)) continue // transfer voids old vouches
      if (v.expires_at !== undefined && v.expires_at !== 0n && now > v.expires_at) continue
      if (vouchWithdrawn(v, withdraws)) continue
      if (samePub(v.delegator_pub, operator)) return true // root-signed: durable
      // The delegator must be a live device in the operator's tree. A revoked
      // or unknown delegator is not evidence of anything — skip it.
      const dt = await this.resolveAwait(v.delegator_pub, stack)
      if (dt.state === 'verified' && samePub(dt.memberPub, operator)) return true
    }
    return false
  }

  // --- member roots (room rosters) ---------------------------------------
  //
  // Distinct from resolve(), which takes a SENDING key and walks up the chain.
  // A roster stores member roots, which never sign events themselves, so there
  // is no chain to walk — we look the attestation up directly.

  /** memberPubHex → attested display name. */
  private memberNames = $state<Record<string, string>>({})
  /** memberPubHex → attested kind ('human' | 'agent' | 'service'). Kept
   *  alongside the name — rosters need it for the agent badge and (once
   *  enforced) admit_kind, and it used to be dropped at this boundary. */
  private memberKinds = $state<Record<string, string>>({})
  private memberInflight = new Set<string>()

  /** Attested name for a member root, or '' if we can't verify one. */
  memberName(memberPubHex: string): string {
    return this.memberNames[memberPubHex] ?? ''
  }

  /** Attested kind for a member root, or '' if unknown. */
  memberKind(memberPubHex: string): string {
    return this.memberKinds[memberPubHex] ?? ''
  }

  resolveMember(memberPub: Uint8Array) {
    const key = hex(memberPub)
    if (this.memberNames[key] !== undefined || this.memberInflight.has(key)) return
    this.memberInflight.add(key)
    void (async () => {
      try {
        const res = await cairn.resolveSender({ senderPub: memberPub })
        const att = dec<IdentityAttestation>(res.attestation)
        // v2: a self-attestation that verifies and names this member root is
        // enough to show its self-asserted name (trust is an edge decision).
        if (att && verifyAttestation(att) && hex(att.pubkey) === key) {
          this.memberNames = { ...this.memberNames, [key]: att.display_name }
          this.memberKinds = { ...this.memberKinds, [key]: att.kind }
        }
      } catch {
        /* offline; retries next time the roster opens */
      } finally {
        this.memberInflight.delete(key)
      }
    })()
  }

  /** Forget everything (e.g. on identity change). */
  clear() {
    this.entries = {}
    this.memberNames = {}
    this.memberKinds = {}
  }
}

export const directory = new Directory()
