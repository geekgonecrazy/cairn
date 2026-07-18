// Persistent browser identity — what replaces the Phase-1 throwaway key.
//
// Key tiers and where each lives (PROTOCOL.md §1, decisions.md §Household-root):
//
//   household root  — NOT STORED. Derived from the 24 words only when signing an
//                     attestation, then dropped. Nothing on this device can
//                     re-mint members after onboarding without the words.
//   member root     — localStorage. This is "you"; stable across tabs and
//                     restarts. Signs device delegations and revocations.
//   device key      — localStorage. This browser profile. Delegated by the
//                     member root; revocable.
//   session key     — sessionStorage, per tab (see crypto.ts). Unchanged.
//
// NOTE: this makes two tabs ONE member, where Phase 1 made them two distinct
// participants. The two-tab convergence demo now needs two browser profiles (or
// a normal + private window), which is the honest arrangement anyway: two tabs
// were never two people.

import { ed25519 } from '@noble/curves/ed25519.js'
import { cacheClear } from './idb'
import {
  bootstrapHousehold,
  householdRootFromMnemonic,
  provisionMember,
  approvePairing,
  revokeDevice,
  newPairingRequest,
  newJoinRequest,
  encodeJoinRequest,
  parseJoinRequest,
  encodeAttestation,
  parseAttestation,
  fingerprint,
  type DeviceDelegation,
  type DeviceRevoke,
  type IdentityAttestation,
  type Kind,
} from './identity'

const K_MEMBER_SK = 'cairn-member-sk'
const K_DEVICE_SK = 'cairn-device-sk'
const K_ATTESTATION = 'cairn-attestation'
const K_DELEGATION = 'cairn-delegation'
const K_HOUSEHOLD = 'cairn-household-pub'
const K_DEVICE_LABEL = 'cairn-device-label'
const K_PEER_DEVICES = 'cairn-peer-devices'

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
  memberPub: Uint8Array
  memberPriv: Uint8Array
  devicePub: Uint8Array
  devicePriv: Uint8Array
  householdPub: Uint8Array
  attestation: IdentityAttestation
  delegation: DeviceDelegation
  displayName: string
  kind: Kind
  deviceLabel: string
}

/** The identity in storage, or null if this browser has never been onboarded. */
export function loadIdentity(): Identity | null {
  const memberSk = localStorage.getItem(K_MEMBER_SK)
  const deviceSk = localStorage.getItem(K_DEVICE_SK)
  const attRaw = localStorage.getItem(K_ATTESTATION)
  const delRaw = localStorage.getItem(K_DELEGATION)
  const hh = localStorage.getItem(K_HOUSEHOLD)
  if (!memberSk || !deviceSk || !attRaw || !delRaw || !hh) return null

  try {
    const memberPriv = unb64(memberSk)
    const devicePriv = unb64(deviceSk)
    const attestation = decodeObj<IdentityAttestation>(attRaw)
    return {
      memberPriv,
      memberPub: ed25519.getPublicKey(memberPriv),
      devicePriv,
      devicePub: ed25519.getPublicKey(devicePriv),
      householdPub: unb64(hh),
      attestation,
      delegation: decodeObj<DeviceDelegation>(delRaw),
      displayName: attestation.display_name,
      kind: attestation.kind,
      deviceLabel: localStorage.getItem(K_DEVICE_LABEL) ?? 'this browser',
    }
  } catch {
    // Corrupt or half-written vault: treat as un-onboarded rather than crashing
    // into a broken session. The words can always re-derive the household.
    return null
  }
}

function persist(id: {
  memberPriv: Uint8Array
  devicePriv: Uint8Array
  householdPub: Uint8Array
  attestation: IdentityAttestation
  delegation: DeviceDelegation
  deviceLabel: string
}) {
  localStorage.setItem(K_MEMBER_SK, b64(id.memberPriv))
  localStorage.setItem(K_DEVICE_SK, b64(id.devicePriv))
  localStorage.setItem(K_HOUSEHOLD, b64(id.householdPub))
  localStorage.setItem(K_ATTESTATION, encodeObj(id.attestation as unknown as Record<string, unknown>))
  localStorage.setItem(K_DELEGATION, encodeObj(id.delegation as unknown as Record<string, unknown>))
  localStorage.setItem(K_DEVICE_LABEL, id.deviceLabel)
}

/**
 * Mint a member root + device key under `mnemonic`'s household and persist them.
 * Shared by first-run bootstrap and by recovery — recovery is not a restore, it
 * is exactly this operation run again with the same words (decisions.md).
 */
function provisionInto(
  mnemonic: string,
  passphrase: string,
  displayName: string,
  kind: Kind,
  deviceLabel: string,
): Identity {
  const memberPriv = newSecret()
  const memberPub = ed25519.getPublicKey(memberPriv)
  const devicePriv = newSecret()
  const devicePub = ed25519.getPublicKey(devicePriv)
  const now = BigInt(Date.now())

  const attestation = provisionMember(mnemonic, passphrase, memberPub, kind, displayName, null, now)
  const delegation = approvePairing(
    newPairingRequest(devicePub, deviceLabel),
    memberPub,
    memberPriv,
    now,
  )
  const householdPub = householdRootFromMnemonic(mnemonic, passphrase).pub

  persist({ memberPriv, devicePriv, householdPub, attestation, delegation, deviceLabel })
  return {
    memberPub, memberPriv, devicePub, devicePriv, householdPub,
    attestation, delegation, displayName, kind, deviceLabel,
  }
}

export interface BootstrapResult {
  identity: Identity
  /** Shown ONCE. Never persisted; unrecoverable from Cairn after this. */
  mnemonic: string
}

/** First run: new household, new member, this device. */
export function bootstrap(displayName: string, deviceLabel: string): BootstrapResult {
  const hh = bootstrapHousehold()
  return {
    identity: provisionInto(hh.mnemonic, '', displayName, 'human', deviceLabel),
    mnemonic: hh.mnemonic,
  }
}

/**
 * Recovery: re-derive the household from the words and re-attest a fresh member
 * root. The household id is unchanged, so peers' trustedRoots still work.
 *
 * This does NOT recover message history — per-room keys were never in the words,
 * and pre-join history stays opaque (PROTOCOL.md §3). Callers must say so.
 */
export function recover(
  mnemonic: string,
  passphrase: string,
  displayName: string,
  deviceLabel: string,
): Identity {
  return provisionInto(mnemonic, passphrase, displayName, 'human', deviceLabel)
}

// --- joining an existing household ----------------------------------------
//
// A household is bootstrapped ONCE, by its founder. Everyone else joins it.
// The newcomer holds a member key with no standing until someone with the
// household's 24 words attests it — which is why `bootstrap` must not be the
// default path in onboarding.

const K_PENDING_JOIN = 'cairn-pending-join'

interface PendingJoin {
  memberPriv: Uint8Array
  devicePriv: Uint8Array
  displayName: string
  deviceLabel: string
}

/**
 * Step 1 (newcomer): mint a member + device key and return the join code to
 * hand to someone already in the household. Keys are held provisionally — this
 * device has NO standing until the attestation comes back.
 */
export function beginJoin(displayName: string, deviceLabel: string): string {
  const memberPriv = newSecret()
  const devicePriv = newSecret()
  const pending: PendingJoin = { memberPriv, devicePriv, displayName, deviceLabel }
  localStorage.setItem(K_PENDING_JOIN, encodeObj(pending as unknown as Record<string, unknown>))
  return encodeJoinRequest(newJoinRequest(ed25519.getPublicKey(memberPriv), displayName))
}

/** The in-progress join on this device, if any (so the UI can resume it). */
export function pendingJoin(): { code: string; displayName: string } | null {
  const raw = localStorage.getItem(K_PENDING_JOIN)
  if (!raw) return null
  try {
    const p = decodeObj<PendingJoin>(raw)
    return {
      code: encodeJoinRequest(newJoinRequest(ed25519.getPublicKey(p.memberPriv), p.displayName)),
      displayName: p.displayName,
    }
  } catch {
    return null
  }
}

/**
 * Step 2 (inviter): attest a pasted join code with the household's words. The
 * root is re-derived, used, and dropped — nothing apex-level is left behind.
 */
export function attestJoinRequest(
  mnemonic: string,
  passphrase: string,
  joinCode: string,
): string {
  const req = parseJoinRequest(joinCode)
  const att = provisionMember(
    mnemonic,
    passphrase,
    req.memberPub,
    'human',
    req.displayName,
    null,
    BigInt(Date.now()),
  )
  return encodeAttestation(att)
}

/**
 * Step 3 (newcomer): import the signed attestation and become a real member.
 *
 * The attestation's signature is verified in parseAttestation, and we check it
 * names OUR member key — otherwise a copied-from-someone-else invite would
 * install an identity whose private key we do not hold.
 */
export function completeJoin(attestationBlob: string): Identity {
  const raw = localStorage.getItem(K_PENDING_JOIN)
  if (!raw) throw new Error('No join in progress on this device. Start again.')
  const pending = decodeObj<PendingJoin>(raw)
  const att = parseAttestation(attestationBlob)

  const memberPub = ed25519.getPublicKey(pending.memberPriv)
  if (hex(att.pubkey) !== hex(memberPub)) {
    throw new Error(
      'This invite was issued for a different person. Ask for one made from YOUR join code.',
    )
  }

  const devicePub = ed25519.getPublicKey(pending.devicePriv)
  const delegation = approvePairing(
    newPairingRequest(devicePub, pending.deviceLabel),
    memberPub,
    pending.memberPriv,
    BigInt(Date.now()),
  )
  persist({
    memberPriv: pending.memberPriv,
    devicePriv: pending.devicePriv,
    householdPub: att.origin,
    attestation: att,
    delegation,
    deviceLabel: pending.deviceLabel,
  })
  localStorage.removeItem(K_PENDING_JOIN)
  return loadIdentity()!
}

export function cancelJoin() {
  localStorage.removeItem(K_PENDING_JOIN)
}

/**
 * Wipe EVERYTHING this device holds: identity, room keys, epochs, paired-device
 * records, any in-flight join, the session key, and the local DAG cache.
 *
 * Deliberately not called "log out". There is no server session to end — the
 * keys ARE the account, so this destroys them. Consequences the UI must state
 * before calling:
 *
 *  - Without the 24 words, the household is gone from this device for good.
 *  - Room keys are destroyed, so past messages become unreadable even after
 *    rejoining: you are re-admitted at a NEW epoch and pre-join history stays
 *    opaque (PROTOCOL.md §3).
 *  - It revokes nothing. Other members still trust this device key until a
 *    DeviceRevoke says otherwise — and this device can no longer issue one.
 *
 * The DAG cache must go too: it is a full copy of room history, and a client
 * that keeps it re-uploads everything to the server on reconnect.
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

/** Wipe this device's identity. Does not revoke it for anyone else — that needs
 *  a DeviceRevoke from the member root, which other devices must see. */
export function forgetIdentity() {
  for (const k of [K_MEMBER_SK, K_DEVICE_SK, K_ATTESTATION, K_DELEGATION, K_HOUSEHOLD, K_DEVICE_LABEL]) {
    localStorage.removeItem(k)
  }
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

/** Admit a scanned device under this member root and remember the delegation. */
export function admitDevice(id: Identity, devicePub: Uint8Array, label: string): DeviceDelegation {
  const delegation = approvePairing(
    newPairingRequest(devicePub, label),
    id.memberPub,
    id.memberPriv,
    BigInt(Date.now()),
  )
  const list = peerDevices()
  const existing = list.find((d) => hex(d.delegation.device_pub) === hex(devicePub))
  // Revocation is permanent and must be checked BEFORE the already-paired case:
  // a revoked key is assumed compromised, and Go's DeviceLog.AddDelegation
  // refuses it outright. Relying on the stale list entry to block this would
  // silently start re-admitting compromised keys the day the list is pruned.
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

/** Revoke a paired device. Revocation is permanent: a revoked key is treated as
 *  compromised and can never be re-paired (identity/log.go). */
export function revokePeerDevice(id: Identity, devicePub: Uint8Array): DeviceRevoke {
  const revoked = revokeDevice(devicePub, id.memberPub, id.memberPriv, BigInt(Date.now()))
  savePeerDevices(
    peerDevices().map((d) =>
      hex(d.delegation.device_pub) === hex(devicePub) ? { ...d, revoked } : d,
    ),
  )
  return revoked
}

export { fingerprint, hex }
