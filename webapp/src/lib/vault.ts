// Persistent browser identity.
//
// v2 trust model (docs/adrs/0013-pubkey-identity-no-household.md): identity is a self-sovereign
// member key + a device tree. There is no household root and no attestation by a
// household — a member self-attests, and trust in that key is decided at the edge
// by whoever you talk to.
//
// Key tiers and where each lives:
//
//   member key   — NOT STORED. Derived from the member's 24 words to self-attest
//                  and sign their FIRST device delegation, then dropped. Only the
//                  PUBLIC half is kept.
//   device key   — localStorage. This browser profile. Delegated by the member
//                  key (first device) or another device (every one paired after
//                  that), and revocable.
//   session key  — sessionStorage, per tab (see crypto.ts). Unchanged.
//
// The member key is offline for a specific reason: it is the authority that
// admits devices, so a device holding it could mint itself a replacement and walk
// back in after being revoked. Keeping it in the words is what makes "revoke a
// device" true. It follows that room keys must wrap to DEVICE keys — there is no
// member secret here to unwrap with (see crypto.ts).
//
// NOTE: this makes two tabs ONE member. The two-tab convergence demo needs two
// browser profiles (or a normal + private window) — two tabs were never two
// people.

import { ed25519 } from '@noble/curves/ed25519.js'
import { cacheClear } from './idb'
import {
  newMemberRoot,
  memberRootFromMnemonic,
  newSelfAttestation,
  approvePairing,
  revokeDevice,
  newPairingRequest,
  encodePairingRequest,
  verifyDeviceDelegation,
  verifyAttestation as verifyAttestationSig,
  fingerprint,
  issueAgentVouch,
  withdrawVouch,
  standaloneDeviceKey,
  type KeyPair,
  type DeviceDelegation,
  type DeviceRevoke,
  type IdentityAttestation,
  type AgentDelegation,
  type VouchWithdraw,
  type Kind,
} from './identity'

const K_MEMBER_PUB = 'cairn-member-pub' // PUBLIC half only; the secret is in the words
const K_DEVICE_SK = 'cairn-device-sk'
const K_ATTESTATION = 'cairn-attestation'
const K_DELEGATION = 'cairn-delegation'
const K_DEVICE_LABEL = 'cairn-device-label'
const K_PEER_DEVICES = 'cairn-peer-devices'
const K_MY_AGENTS = 'cairn-my-agents'

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b))
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

/** JSON round-trip for identity objects, whose fields are bytes and bigints. */
function encodeObj(o: Record<string, unknown>): string {
  return JSON.stringify(o, (_k, v) => {
    if (v instanceof Uint8Array) return { __b: b64(v) }
    if (typeof v === 'bigint') return { __n: v.toString() }
    return v
  })
}
function decodeObj<T>(s: string): T {
  return JSON.parse(s, (_k, v) => {
    if (v && typeof v === 'object' && '__b' in v) return unb64((v as { __b: string }).__b)
    if (v && typeof v === 'object' && '__n' in v) return BigInt((v as { __n: string }).__n)
    return v
  }) as T
}

function newSecret(): Uint8Array {
  const u = ed25519.utils as {
    randomSecretKey?: () => Uint8Array
    randomPrivateKey?: () => Uint8Array
  }
  return (u.randomSecretKey ?? u.randomPrivateKey)!()
}

export interface Identity {
  /** PUBLIC only. The member secret lives in the member's recovery words and is
   *  never on a device — see the header. Anything needing it (admitting a first
   *  device, revoking above a device) re-derives it from the words. */
  memberPub: Uint8Array
  devicePub: Uint8Array
  devicePriv: Uint8Array
  attestation: IdentityAttestation
  delegation: DeviceDelegation
  displayName: string
  kind: Kind
  deviceLabel: string
}

/** The identity in storage, or null if this browser has never been onboarded. */
export function loadIdentity(): Identity | null {
  const memberPub = localStorage.getItem(K_MEMBER_PUB)
  const deviceSk = localStorage.getItem(K_DEVICE_SK)
  const attRaw = localStorage.getItem(K_ATTESTATION)
  const delRaw = localStorage.getItem(K_DELEGATION)
  if (!memberPub || !deviceSk || !attRaw || !delRaw) return null

  try {
    const devicePriv = unb64(deviceSk)
    const attestation = decodeObj<IdentityAttestation>(attRaw)
    return {
      memberPub: unb64(memberPub),
      devicePriv,
      devicePub: ed25519.getPublicKey(devicePriv),
      attestation,
      delegation: decodeObj<DeviceDelegation>(delRaw),
      displayName: attestation.display_name,
      kind: attestation.kind,
      deviceLabel: localStorage.getItem(K_DEVICE_LABEL) ?? 'this browser',
    }
  } catch {
    // Corrupt or half-written vault: treat as un-onboarded rather than crashing
    // into a broken session. The words can always re-derive the identity.
    return null
  }
}

/**
 * Re-derive the member root from the member's recovery words, checking it is
 * actually OURS. Needed for the two operations no device key can do: admitting a
 * first device, and revoking a device that no live device sits above.
 *
 * The check matters — a valid but different phrase silently yields a different
 * member key (BIP-39 has no wrong answers), and signing with it would produce
 * objects that verify perfectly and belong to nobody.
 */
export function memberRootFromWords(
  id: Identity,
  mnemonic: string,
  passphrase = '',
): { pub: Uint8Array; priv: Uint8Array } {
  const kp = memberRootFromMnemonic(mnemonic, passphrase)
  if (hex(kp.pub) !== hex(id.memberPub)) {
    throw new Error(
      'Those words derive a different member key than this device holds. Check the ' +
        'phrase (and the passphrase, if your account uses one) — a wrong phrase does ' +
        'not error, it just produces a different identity.',
    )
  }
  return kp
}

function persist(id: {
  memberPub: Uint8Array
  devicePriv: Uint8Array
  attestation: IdentityAttestation
  delegation: DeviceDelegation
  deviceLabel: string
}) {
  localStorage.setItem(K_MEMBER_PUB, b64(id.memberPub))
  localStorage.setItem(K_DEVICE_SK, b64(id.devicePriv))
  localStorage.setItem(K_ATTESTATION, encodeObj(id.attestation as unknown as Record<string, unknown>))
  localStorage.setItem(K_DELEGATION, encodeObj(id.delegation as unknown as Record<string, unknown>))
  localStorage.setItem(K_DEVICE_LABEL, id.deviceLabel)
}

export interface BootstrapResult {
  identity: Identity
  /**
   * YOUR phrase. Recovers your member identity and revokes a device that no live
   * device sits above. Shown ONCE and never persisted.
   */
  memberMnemonic: string
  /**
   * Write the identity to storage.
   *
   * Deliberately NOT done at mint time. Persisting first meant a reload at the
   * "write these words down" screen landed the user in a working app having never
   * confirmed — or read — the phrase, which is then gone for good since it is
   * never stored. The gate has to hold the identity in memory until the words are
   * confirmed, or it guards nothing.
   */
  commit: () => void
}

// --- onboarding: create or recover a self-sovereign identity --------------
//
// v2: there is no household to join and no invite to wait for. A member mints a
// key, self-attests a profile, and signs their first device delegation — all in
// one shot. Trust in the key is decided at the edge by whoever they talk to.

function buildSelfAttested(
  keys: KeyPair,
  memberMnemonic: string,
  displayName: string,
  deviceLabel: string,
  kind: Kind,
): BootstrapResult {
  const now = BigInt(Date.now())
  const attestation = newSelfAttestation(keys, kind, displayName, null, now)
  const devicePriv = newSecret()
  const devicePub = ed25519.getPublicKey(devicePriv)
  const delegation = approvePairing(
    newPairingRequest(devicePub, deviceLabel),
    keys.pub,
    keys.priv,
    now,
  )
  const identity: Identity = {
    memberPub: keys.pub,
    devicePub,
    devicePriv,
    attestation,
    delegation,
    displayName,
    kind,
    deviceLabel,
  }
  return {
    identity,
    memberMnemonic,
    // Same rule as before: nothing is written until the words are confirmed.
    commit: () => persist({ memberPub: keys.pub, devicePriv, attestation, delegation, deviceLabel }),
  }
}

/** Create a brand-new identity from fresh recovery words. */
export function createIdentity(displayName: string, deviceLabel: string, kind: Kind = 'human'): BootstrapResult {
  const member = newMemberRoot()
  return buildSelfAttested(member.keys, member.mnemonic, displayName, deviceLabel, kind)
}

/**
 * Recover an identity from its recovery words: re-derive the member key, mint a
 * FRESH device key, and re-create the self-attestation. Same words → same member
 * key, so peers who already trust you keep doing so; only this device is new.
 */
export function recoverIdentity(
  mnemonic: string,
  displayName: string,
  deviceLabel: string,
  passphrase = '',
  kind: Kind = 'human',
): BootstrapResult {
  const keys = memberRootFromMnemonic(mnemonic, passphrase)
  return buildSelfAttested(keys, mnemonic, displayName, deviceLabel, kind)
}

/**
 * Recover using a self-attestation already published to the carrier (fetched by
 * identity.recoverFromCarrier). Re-derives the member key from the words, checks
 * the fetched attestation names it and verifies, mints a FRESH device key, and
 * reuses the attestation so the display name is preserved without re-entry.
 */
export function recoverWithAttestation(
  memberMnemonic: string,
  attestation: IdentityAttestation,
  deviceLabel: string,
): BootstrapResult {
  const member = memberRootFromMnemonic(memberMnemonic)
  if (hex(attestation.pubkey) !== hex(member.pub)) {
    throw new Error(
      'Those words do not match the account that attestation is for. Check the phrase — ' +
        'a wrong phrase does not error, it just derives a different identity.',
    )
  }
  if (!verifyAttestationSig(attestation)) {
    throw new Error('That attestation has a bad signature.')
  }
  const devicePriv = newSecret()
  const devicePub = ed25519.getPublicKey(devicePriv)
  const delegation = approvePairing(
    newPairingRequest(devicePub, deviceLabel),
    member.pub,
    member.priv,
    BigInt(Date.now()),
  )
  const identity: Identity = {
    memberPub: member.pub,
    devicePub,
    devicePriv,
    attestation,
    delegation,
    displayName: attestation.display_name,
    kind: attestation.kind,
    deviceLabel,
  }
  return {
    identity,
    memberMnemonic,
    commit: () => persist({ memberPub: member.pub, devicePriv, attestation, delegation, deviceLabel }),
  }
}

/**
 * Wipe EVERYTHING this device holds: identity, room keys, epochs, paired-device
 * records, any in-flight pairing, the session key, and the local DAG cache.
 *
 * Deliberately not called "log out". There is no server session to end — the keys
 * ARE the account, so this destroys them. Consequences the UI must state before
 * calling:
 *
 *  - Without the 24 words, this identity is gone from this device for good.
 *  - Room keys are destroyed, so past messages become unreadable even after
 *    rejoining: you are re-admitted at a NEW epoch and pre-join history stays
 *    opaque (docs/protocol.md §3).
 *  - It revokes nothing. Other members still trust this device key until a
 *    DeviceRevoke says otherwise — and this device can no longer issue one.
 *
 * The DAG cache must go too: it is a full copy of room history, and a client that
 * keeps it re-uploads everything to the server on reconnect.
 */
export async function resetDevice(): Promise<void> {
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith('cairn-')) localStorage.removeItem(k)
  }
  for (const k of Object.keys(sessionStorage)) {
    if (k.startsWith('cairn-')) sessionStorage.removeItem(k)
  }
  try {
    await cacheClear()
  } catch {
    // A failed cache clear would leave history to re-upload; surface it rather
    // than reporting a clean wipe that isn't.
    throw new Error('Identity cleared, but the local message cache could not be. Clear site data.')
  }
}

/** Wipe this device's identity. Does not revoke it for anyone else — that needs a
 *  DeviceRevoke from the member root, which other devices must see. */
export function forgetIdentity() {
  for (const k of [K_MEMBER_PUB, K_DEVICE_SK, K_ATTESTATION, K_DELEGATION, K_DEVICE_LABEL]) {
    localStorage.removeItem(k)
  }
}

// --- pairing THIS device onto an existing account -------------------------
//
// The mirror image of the peer-device list below: this is the NEW device's side.
// It mints a device key, shows it as a QR, and waits for a device already in the
// account to publish a delegation for it. No secret travels in either direction —
// the QR carries a public key, and what comes back is a signed delegation anyone
// could read.

const K_PENDING_PAIR = 'cairn-pending-pair'

interface PendingPair {
  devicePriv: Uint8Array
  deviceLabel: string
}

/** Step 1 (new device): mint a device key and return the code to show. */
export function beginDevicePairing(deviceLabel: string): { code: string; devicePub: Uint8Array } {
  const devicePriv = newSecret()
  const devicePub = ed25519.getPublicKey(devicePriv)
  const pending: PendingPair = { devicePriv, deviceLabel }
  localStorage.setItem(K_PENDING_PAIR, encodeObj(pending as unknown as Record<string, unknown>))
  return { code: encodePairingRequest(newPairingRequest(devicePub, deviceLabel)), devicePub }
}

/** The in-progress pairing on this device, if any (so the UI can resume it). */
export function pendingDevicePairing(): {
  code: string
  devicePub: Uint8Array
  deviceLabel: string
} | null {
  const raw = localStorage.getItem(K_PENDING_PAIR)
  if (!raw) return null
  try {
    const p = decodeObj<PendingPair>(raw)
    const devicePub = ed25519.getPublicKey(p.devicePriv)
    return {
      code: encodePairingRequest(newPairingRequest(devicePub, p.deviceLabel)),
      devicePub,
      deviceLabel: p.deviceLabel,
    }
  } catch {
    return null
  }
}

export function cancelDevicePairing() {
  localStorage.removeItem(K_PENDING_PAIR)
}

/**
 * Step 3 (new device): the delegation arrived. Verify it end to end and become a
 * real device.
 *
 * Everything is re-checked locally, because these objects came from the carrier
 * and the carrier is not an authority:
 *
 *  - the delegation names OUR device key (else it is somebody else's pairing),
 *  - its signature verifies under the parent it claims,
 *  - the chain terminates at the member key the attestation names,
 *  - the attestation self-verifies under that member key.
 *
 * What CANNOT be checked here is that this is the RIGHT member — the name is
 * self-asserted, so a stranger's account verifies its own chain perfectly. That
 * is what the fingerprint comparison during the scan is for, and why the caller
 * must show `fingerprint(att.pubkey)` before this is treated as done.
 */
export function completeDevicePairing(
  delegationChain: DeviceDelegation[],
  attestation: IdentityAttestation,
): Identity {
  const raw = localStorage.getItem(K_PENDING_PAIR)
  if (!raw) throw new Error('No pairing in progress on this device. Start again.')
  const pending = decodeObj<PendingPair>(raw)
  const devicePub = ed25519.getPublicKey(pending.devicePriv)

  const mine = delegationChain.find((d) => hex(d.device_pub) === hex(devicePub))
  if (!mine) {
    throw new Error('That approval was issued for a different device. Ask them to scan again.')
  }
  // Walk our own chain to the member root, verifying each hop — the same walk
  // every other member will run against us. Refusing here rather than persisting
  // means we never end up as a device nobody else accepts.
  let cur: Uint8Array = devicePub
  const seen = new Set<string>()
  for (let i = 0; i <= 8; i++) {
    if (seen.has(hex(cur))) throw new Error('That approval chain loops on itself.')
    seen.add(hex(cur))
    const dd = delegationChain.find((d) => hex(d.device_pub) === hex(cur))
    if (!dd) break
    if (!verifyDeviceDelegation(dd)) {
      throw new Error('That approval has a bad signature. Ask them to scan again.')
    }
    cur = dd.parent_pub
  }
  if (hex(cur) !== hex(attestation.pubkey)) {
    throw new Error('That approval does not lead to the account it claims.')
  }
  if (!verifyAttestationSig(attestation)) {
    throw new Error('The account attestation has a bad signature.')
  }

  persist({
    memberPub: attestation.pubkey,
    devicePriv: pending.devicePriv,
    attestation,
    delegation: mine,
    deviceLabel: pending.deviceLabel,
  })
  localStorage.removeItem(K_PENDING_PAIR)
  return loadIdentity()!
}

// --- paired peer devices --------------------------------------------------
// Devices this member has admitted, so the settings surface can list and revoke
// them. Delegations we issued for OTHER devices; this device is separate.

export interface PeerDevice {
  label: string
  delegation: DeviceDelegation
  revoked?: DeviceRevoke
}

export function peerDevices(): PeerDevice[] {
  const raw = localStorage.getItem(K_PEER_DEVICES)
  if (!raw) return []
  try {
    return decodeObj<PeerDevice[]>(raw)
  } catch {
    return []
  }
}

function savePeerDevices(list: PeerDevice[]) {
  localStorage.setItem(K_PEER_DEVICES, encodeObj(list as unknown as Record<string, unknown>))
}

/**
 * Admit a scanned device under THIS DEVICE and remember the delegation.
 *
 * The parent is this device's key, not the member root — the member root is
 * offline, and requiring the words to add a device would make pairing a ceremony.
 * The new device becomes a child of this one, which is also what makes the cascade
 * meaningful: if this device is later revoked, everything it admitted goes with it.
 */
export function admitDevice(id: Identity, devicePub: Uint8Array, label: string): DeviceDelegation {
  const delegation = approvePairing(
    newPairingRequest(devicePub, label),
    id.devicePub,
    id.devicePriv,
    BigInt(Date.now()),
  )
  const list = peerDevices()
  const existing = list.find((d) => hex(d.delegation.device_pub) === hex(devicePub))
  // Revocation is permanent and must be checked BEFORE the already-paired case: a
  // revoked key is assumed compromised, and Go's DeviceLog.AddDelegation refuses
  // it outright. Relying on the stale list entry to block this would silently
  // start re-admitting compromised keys the day the list is pruned.
  if (existing?.revoked) {
    throw new Error(
      'That device was revoked. A revoked key is treated as compromised and cannot be ' +
        'paired again — set the device up as a new one instead.',
    )
  }
  if (existing) {
    throw new Error('That device is already paired.')
  }
  list.push({ label, delegation })
  savePeerDevices(list)
  return delegation
}

/**
 * Revoke a device THIS DEVICE admitted. A revoke binds only from an ancestor, and
 * this device is the parent of everything in its peer list, so its own key is
 * sufficient — no words needed for the common case.
 *
 * Revocation is permanent (a revoked key is assumed compromised and can never be
 * re-paired) and it CASCADES: every device paired from this one goes too. Callers
 * must show `subtreeOf(devicePub)` before confirming.
 */
export function revokePeerDevice(id: Identity, devicePub: Uint8Array): DeviceRevoke {
  const revoked = revokeDevice(devicePub, id.devicePub, id.devicePriv, BigInt(Date.now()))
  savePeerDevices(
    peerDevices().map((d) =>
      hex(d.delegation.device_pub) === hex(devicePub) ? { ...d, revoked } : d,
    ),
  )
  return revoked
}

/**
 * Revoke a device this one did NOT admit — including the case that matters most:
 * revoking a device that sits ABOVE this one, or the last device you can still
 * reach. Only the member root is an ancestor of everything, so this needs the
 * member's recovery words.
 *
 * That cost is the point. A revoke signed by a peer would let a thief with one
 * device permanently destroy access to the others.
 */
export function revokeWithMemberRoot(
  id: Identity,
  devicePub: Uint8Array,
  mnemonic: string,
  passphrase = '',
): DeviceRevoke {
  const root = memberRootFromWords(id, mnemonic, passphrase)
  const revoked = revokeDevice(devicePub, root.pub, root.priv, BigInt(Date.now()))
  savePeerDevices(
    peerDevices().map((d) =>
      hex(d.delegation.device_pub) === hex(devicePub) ? { ...d, revoked } : d,
    ),
  )
  return revoked
}

/**
 * The device and everything paired from it — exactly what a revocation takes
 * down. Computed over the delegations this device knows about (its peer list plus
 * its own), which is what the settings surface can show.
 */
export function subtreeOf(devicePub: Uint8Array): Uint8Array[] {
  const all = peerDevices().map((d) => d.delegation)
  const out: Uint8Array[] = [devicePub]
  // Repeated sweeps: the list is unordered, so a child may be seen before its
  // parent is known to be in the set.
  for (let i = 0; i < 8; i++) {
    let grew = false
    for (const dd of all) {
      if (out.some((p) => hex(p) === hex(dd.device_pub))) continue
      if (out.some((p) => hex(p) === hex(dd.parent_pub))) {
        out.push(dd.device_pub)
        grew = true
      }
    }
    if (!grew) break
  }
  return out
}

export { fingerprint, hex }

// --- my agents ---------------------------------------------------------------
//
// Agents THIS human created and vouched for. PUBLIC material only: the agent's
// pubkey, its device pubkey, and our vouch. The agent's PRIVATE key is never
// persisted here — it left in the show-once handoff bundle, and this device
// does not need it: vouching, re-vouching and withdrawing all sign with OUR
// device key, not the agent's.

export interface MyAgent {
  name: string
  agentPub: Uint8Array
  /** The agent's device pubkey (derived, stable) — for proof-status checks. */
  devicePub: Uint8Array
  /** Our vouch, as published. Withdrawing signs a new object from it. */
  vouch: AgentDelegation
  /** Set when we withdrew our vouch (local tombstone; the relay holds proof). */
  withdrawnAt?: bigint
}

export function myAgents(): MyAgent[] {
  const raw = localStorage.getItem(K_MY_AGENTS)
  if (!raw) return []
  try {
    return decodeObj<MyAgent[]>(raw)
  } catch {
    return []
  }
}

function saveMyAgents(list: MyAgent[]) {
  localStorage.setItem(K_MY_AGENTS, encodeObj(list as unknown as Record<string, unknown>))
}

/** Remember an agent we just created and vouched for (public material only). */
export function rememberAgent(a: MyAgent) {
  const list = myAgents().filter((x) => hex(x.agentPub) !== hex(a.agentPub))
  list.push(a)
  saveMyAgents(list)
}

export function forgetAgent(agentPub: Uint8Array) {
  saveMyAgents(myAgents().filter((x) => hex(x.agentPub) !== hex(agentPub)))
}

/**
 * Mint an agent owned by this identity: a fresh member root, its derived
 * device, its self-attestation (kind=agent, operated_by = us), and OUR vouch
 * for it — signed by this device's key, so no words are needed.
 *
 * Returns everything the handoff bundle needs plus the vouch to publish. The
 * agent root's seed is returned for the show-once bundle and MUST NOT be
 * persisted: it goes out of scope with the creation form.
 */
export function mintAgent(
  id: Identity,
  name: string,
  issuedAt: bigint,
): {
  seed: Uint8Array
  attestation: IdentityAttestation
  delegation: DeviceDelegation
  vouch: AgentDelegation
  devicePub: Uint8Array
  agentPub: Uint8Array
} {
  const clean = name.trim()
  if (!clean) throw new Error('Give the agent a name.')
  const agent = newMemberRoot()
  const seed = agent.keys.priv
  const device = standaloneDeviceKey(seed)
  const attestation = newSelfAttestation(agent.keys, 'agent', clean, id.memberPub, issuedAt)
  const delegation = approvePairing(
    newPairingRequest(device.pub, clean),
    agent.keys.pub,
    agent.keys.priv,
    issuedAt,
  )
  const vouch = issueAgentVouch(
    agent.keys.pub,
    id.devicePub,
    id.devicePriv,
    id.memberPub,
    issuedAt,
  )
  return {
    seed,
    attestation,
    delegation,
    vouch,
    devicePub: device.pub,
    agentPub: agent.keys.pub,
  }
}

/**
 * Withdraw OUR vouch for one of our agents. Signed by this device (the vouch's
 * delegator) — self-withdrawal needs no authority beyond that. Withdrawing the
 * last surviving vouch un-proves the agent with no path back by itself.
 */
export function withdrawAgentVouch(id: Identity, agent: MyAgent, withdrawnAt: bigint): VouchWithdraw {
  if (hex(agent.vouch.delegator_pub) !== hex(id.devicePub)) {
    throw new Error(
      'This vouch was made by a different device. Withdraw it from the device that created the agent.',
    )
  }
  const w = withdrawVouch(agent.agentPub, id.devicePub, id.devicePriv, withdrawnAt)
  saveMyAgents(
    myAgents().map((x) =>
      hex(x.agentPub) === hex(agent.agentPub) ? { ...x, withdrawnAt } : x,
    ),
  )
  return w
}
