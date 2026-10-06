// Browser half of the Cairn identity chain — the exact mirror of Go's
// `identity` package. See identity/member.go and identity/identity.go for the
// authoritative comments; this file must stay byte-compatible with them.
//
// PARITY IS LOAD-BEARING. A member key derived in the browser must derive the
// same pubkey, and sign attestations/delegations over the same canonical bytes,
// as Go — otherwise events signed here fail chain-walk verification elsewhere.
// `npm run identity-conformance` asserts the golden vectors that prove it; do not
// change a derivation here without re-running it.
//
// v2 trust model: identity is a self-sovereign member key + device tree. There is
// no household root and no attestation-by-household (docs/adrs/0013-pubkey-identity-no-household.md §Trust
// model v2). A member self-attests; trust in that key is decided at the edge.

import { ed25519 } from '@noble/curves/ed25519.js'
import { sha512 } from '@noble/hashes/sha2.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { blake3 } from '@noble/hashes/blake3.js'
import {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeedSync,
} from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { encode as cborEncode, decode as cborDecode, type CborValue } from './cbor'

/** 24 words = 256 bits of entropy. Shorter phrases are rejected, not stretched. */
export const MNEMONIC_WORDS = 24

/** Domain separation label. MUST match identity/member.go. */
const HKDF_INFO_MEMBER_ROOT = 'cairn/member-root/v1'

export type Kind = 'human' | 'agent' | 'service'

/**
 * Object type tags — part of the SIGNED bytes of every identity-log object.
 * MUST match identity/identity.go's Type* constants.
 */
export const TYPE_ATTESTATION = 'identity_attestation'
export const TYPE_DEVICE_DELEGATION = 'device_delegation'
export const TYPE_SESSION_DELEGATION = 'session_delegation'
export const TYPE_DEVICE_REVOKE = 'device_revoke'
export const TYPE_AGENT_DELEGATION = 'agent_delegation'
export const TYPE_VOUCH_WITHDRAW = 'vouch_withdraw'

export interface KeyPair {
  pub: Uint8Array
  priv: Uint8Array
}

// --- mnemonic -------------------------------------------------------------

/** Generate a fresh 24-word BIP-39 mnemonic (256 bits of entropy). */
export function newMnemonic(): string {
  return generateMnemonic(wordlist, 256)
}

/**
 * Canonicalize a human-typed phrase: lowercase, single-spaced. Case and
 * whitespace are what people get wrong copying words off paper; neither should
 * change the derived key. Deliberately does NOT spell-correct — a typo must fail
 * the checksum rather than snap to a stranger's identity.
 */
export function normalizeMnemonic(s: string): string {
  return s.trim().split(/\s+/).join(' ').toLowerCase()
}

/** Returns null if valid, else a human-readable reason. */
export function validateMnemonicPhrase(s: string): string | null {
  const words = s.trim().length === 0 ? [] : s.trim().split(/\s+/)
  if (words.length !== MNEMONIC_WORDS) {
    return `Recovery phrase must be ${MNEMONIC_WORDS} words — this has ${words.length}.`
  }
  if (!validateMnemonic(normalizeMnemonic(s), wordlist)) {
    return 'That phrase has a typo — check the spelling of each word.'
  }
  return null
}

// --- member key -----------------------------------------------------------

/**
 * Derive a member keypair from its recovery phrase. Same words → same member
 * key (the identity itself), which is what makes recovery work.
 *
 * A member key is the top of its own device tree: it signs the member's FIRST
 * device delegation and is then put away, never persisted. Every device after
 * that is paired from an existing device, which signs as parent — that is what
 * makes device revocation meaningful (a stolen device holds no key that can
 * admit a replacement) and why room keys wrap to DEVICE keys rather than to this
 * one.
 *
 * A different passphrase yields a DIFFERENT key rather than an error — BIP-39's
 * plausible-deniability property. Callers must surface the resulting "nobody
 * recognizes you" state legibly (see docs/adrs/0013-pubkey-identity-no-household.md).
 */
export function memberRootFromMnemonic(mnemonic: string, passphrase = ''): KeyPair {
  const err = validateMnemonicPhrase(mnemonic)
  if (err) throw new Error(err)
  const seed = mnemonicToSeedSync(normalizeMnemonic(mnemonic), passphrase)
  // Domain-separate before touching Ed25519 (mirrors Go's hkdf.New/ReadFull).
  const info = new TextEncoder().encode(HKDF_INFO_MEMBER_ROOT)
  const sk = hkdf(sha512, seed, undefined, info, 32)
  return { priv: sk, pub: ed25519.getPublicKey(sk) }
}

/** A freshly minted member key: the words are shown ONCE and never stored. */
export function newMemberRoot(): { mnemonic: string; keys: KeyPair } {
  const mnemonic = newMnemonic()
  return { mnemonic, keys: memberRootFromMnemonic(mnemonic) }
}

/** Domain separation label. MUST match identity/standalone.go. */
const HKDF_INFO_STANDALONE_DEVICE = 'cairn/standalone-device/v1'

/**
 * Derive the device key a standalone participant (agent harness, CLI) signs
 * with, from the 32-byte root seed it holds. Derived rather than random so it
 * is STABLE: the harness keeps one secret, and the device key room keys wrap
 * to is the same every time it starts. MUST match Go's StandaloneDeviceKey —
 * pinned by conformance.
 *
 * Go feeds the full 64-byte private key (seed || pubkey) to HKDF, so this
 * expands the seed the same way before deriving.
 */
export function standaloneDeviceKey(rootSeed: Uint8Array): KeyPair {
  if (rootSeed.length !== 32) throw new Error('root seed must be 32 bytes')
  const pub = ed25519.getPublicKey(rootSeed)
  const ikm = new Uint8Array(64)
  ikm.set(rootSeed, 0)
  ikm.set(pub, 32)
  const info = new TextEncoder().encode(HKDF_INFO_STANDALONE_DEVICE)
  const sk = hkdf(sha512, ikm, undefined, info, 32)
  return { priv: sk, pub: ed25519.getPublicKey(sk) }
}

// --- identity-log objects -------------------------------------------------

export interface IdentityAttestation {
  type: string // always TYPE_ATTESTATION; signed
  pubkey: Uint8Array
  kind: Kind
  operated_by: Uint8Array | null
  display_name: string
  issued_at: bigint
  sig: Uint8Array | null
}

export interface DeviceDelegation {
  type: string // always TYPE_DEVICE_DELEGATION; signed
  device_pub: Uint8Array
  /** Member root for a member's FIRST device; another device key for every one
   *  paired after that. Devices form a tree — see identity/identity.go. */
  parent_pub: Uint8Array
  issued_at: bigint
  expires_at?: bigint // omitted when 0, matching Go's `omitempty`
  sig: Uint8Array | null
}

export interface SessionDelegation {
  type: string // always TYPE_SESSION_DELEGATION; signed
  session_pub: Uint8Array
  device_pub: Uint8Array
  scope: string
  expires_at: bigint
  sig: Uint8Array | null
}

export interface DeviceRevoke {
  type: string // always TYPE_DEVICE_REVOKE; signed
  device_pub: Uint8Array
  /** Must be an ANCESTOR of device_pub for the revoke to bind. A peer or a
   *  stranger can sign one, and every verifier will ignore it. */
  revoker_pub: Uint8Array
  revoked_at: bigint
  sig: Uint8Array | null
}

export interface AgentDelegation {
  type: string // always TYPE_AGENT_DELEGATION; signed
  agent_pub: Uint8Array
  /** The vouching device key — a device in the operator's tree, or the
   *  operator root itself for a durable, words-issued vouch. */
  delegator_pub: Uint8Array
  /** Must equal the agent's attested operated_by at verify time. That is the
   *  whole transfer story: re-attest, get vouched, old vouches void. */
  operator_pub: Uint8Array
  issued_at: bigint
  expires_at?: bigint // omitted when 0, matching Go's `omitempty`
  sig: Uint8Array | null
}

export interface VouchWithdraw {
  type: string // always TYPE_VOUCH_WITHDRAW; signed
  agent_pub: Uint8Array
  /** The vouch being withdrawn — and the ONLY valid signer. Self-withdrawal is
   *  the only shape verifiers accept. */
  delegator_pub: Uint8Array
  withdrawn_at: bigint
  sig: Uint8Array | null
}

/**
 * Deterministic-CBOR of an object with `sig` cleared to null — exactly what Go's
 * signingBytes produces. Go encodes a nil []byte as CBOR null, so `sig: null`
 * here (not an empty byte string) is what makes the signatures agree.
 */
function signingBytes(obj: Record<string, unknown>, tag: string): Uint8Array {
  // `type` is FORCED to the canonical tag, mirroring Go's signingBytes, so a
  // caller cannot sign an object carrying somebody else's tag.
  return cborEncode({ ...obj, type: tag, sig: null } as CborValue)
}

function signObject<T extends Record<string, unknown>>(
  obj: T,
  priv: Uint8Array,
  tag: string,
): T {
  return { ...obj, type: tag, sig: ed25519.sign(signingBytes(obj, tag), priv) }
}

/** Verify a detached signature. The type tag is checked FIRST: an object
 *  decoded as the wrong shape is rejected before any signature work. */
function verifyObject(
  obj: Record<string, unknown>,
  signerPub: Uint8Array,
  tag: string,
): boolean {
  if (obj.type !== tag) return false
  const sig = obj.sig as Uint8Array | null
  if (!sig || sig.length !== 64 || signerPub.length !== 32) return false
  try {
    return ed25519.verify(sig, signingBytes(obj, tag), signerPub)
  } catch {
    return false
  }
}

/** BLAKE3-256 content address of an object (mirrors Go's identity.Hash). */
export function objectHash(obj: Record<string, unknown>): Uint8Array {
  return blake3(cborEncode(obj as CborValue))
}

/**
 * Mint a member's SELF-signed attestation: its profile (kind, display name, and
 * for agents the operating human), signed by the member key ITSELF. There is no
 * household to countersign it — the name/kind are self-asserted labels a peer
 * decides how much to trust. kind is immutable once published.
 */
export function newSelfAttestation(
  member: KeyPair,
  kind: Kind,
  displayName: string,
  operatedBy: Uint8Array | null,
  issuedAt: bigint,
): IdentityAttestation {
  if (member.pub.length !== 32) throw new Error('member pubkey must be 32 bytes')
  if (kind === 'agent') {
    if (!operatedBy || operatedBy.length !== 32) {
      throw new Error('an agent requires an operated_by member root')
    }
  } else if (operatedBy && operatedBy.length > 0) {
    throw new Error('operated_by is only valid for agents')
  }
  return signObject(
    {
      type: TYPE_ATTESTATION,
      pubkey: member.pub,
      kind,
      operated_by: operatedBy && operatedBy.length ? operatedBy : null,
      display_name: displayName,
      issued_at: issuedAt,
      sig: null,
    } as unknown as Record<string, unknown>,
    member.priv,
    TYPE_ATTESTATION,
  ) as unknown as IdentityAttestation
}

/** Verify a self-attestation against the member key that signed it (the same key
 *  it names). Proves the profile was authored by that key's holder — NOT that you
 *  should trust the key, which is an edge decision. */
export function verifyAttestation(att: IdentityAttestation): boolean {
  return verifyObject(att as unknown as Record<string, unknown>, att.pubkey, TYPE_ATTESTATION)
}

// --- pairing --------------------------------------------------------------

export const PAIRING_VERSION = 1
const PAIRING_PREFIX = 'cairn:pair:'

export interface PairingRequest {
  version: number
  devicePub: Uint8Array
  /** Self-reported and UNATTESTED. Render as untrusted input. */
  label: string
}

const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const unb64url = (s: string) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(b, (c) => c.charCodeAt(0))
}

export function newPairingRequest(devicePub: Uint8Array, label: string): PairingRequest {
  if (devicePub.length !== 32) throw new Error('device pubkey must be 32 bytes')
  if (/[:\n]/.test(label)) throw new Error("pairing label must not contain ':' or newlines")
  return { version: PAIRING_VERSION, devicePub, label }
}

/** `cairn:pair:1:<base64url pub>:<label>` — must match Go's Encode. */
export function encodePairingRequest(p: PairingRequest): string {
  return `${PAIRING_PREFIX}${p.version}:${b64url(p.devicePub)}:${p.label}`
}

export function parsePairingRequest(s: string): PairingRequest {
  const t = s.trim()
  if (!t.startsWith(PAIRING_PREFIX)) throw new Error('Not a Cairn pairing code.')
  const rest = t.slice(PAIRING_PREFIX.length)
  const first = rest.indexOf(':')
  const second = rest.indexOf(':', first + 1)
  if (first < 0 || second < 0) throw new Error('Malformed pairing code.')
  const version = Number(rest.slice(0, first))
  if (!Number.isInteger(version)) throw new Error('Malformed pairing version.')
  if (version !== PAIRING_VERSION) {
    throw new Error(`Unsupported pairing version ${version} (this build speaks ${PAIRING_VERSION}).`)
  }
  let pub: Uint8Array
  try {
    pub = unb64url(rest.slice(first + 1, second))
  } catch {
    throw new Error('Malformed pairing key.')
  }
  if (pub.length !== 32) throw new Error('Pairing key must be 32 bytes.')
  return { version, devicePub: pub, label: rest.slice(second + 1) }
}

/**
 * Short human-comparable groups, shown on BOTH screens during pairing. A
 * comparison aid, not a security boundary — it truncates the key, so a match
 * only means "same key" when the human has both screens in front of them.
 */
export function fingerprint(pub: Uint8Array): string {
  if (pub.length < 8) return ''
  const h = (b: number) => b.toString(16).padStart(2, '0')
  return [0, 1, 2, 3].map((i) => h(pub[i * 2]) + h(pub[i * 2 + 1])).join('-')
}

/** Byte equality for two public keys. */
export function samePub(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * Issue the delegation admitting a device under the PARENT that signs it.
 *
 * The parent is a member root only for a member's first device — signed from
 * their recovery words, which are then dropped. Every later device is paired
 * from an existing device, whose key signs as parent, so adding a device never
 * needs a live copy of the member root (and a stolen device cannot mint itself
 * a fresh sibling).
 */
export function approvePairing(
  req: PairingRequest,
  parentPub: Uint8Array,
  parentPriv: Uint8Array,
  issuedAt: bigint,
  expiresAt: bigint = 0n,
): DeviceDelegation {
  if (req.devicePub.length !== 32) throw new Error('pairing request has no valid device key')
  if (parentPub.length !== 32) throw new Error('parent pubkey must be 32 bytes')
  if (samePub(req.devicePub, parentPub)) throw new Error('a device cannot delegate itself')
  if (expiresAt !== 0n && expiresAt <= issuedAt) {
    throw new Error('expires_at must be after issued_at')
  }
  const obj: Record<string, unknown> = {
    type: TYPE_DEVICE_DELEGATION,
    device_pub: req.devicePub,
    parent_pub: parentPub,
    issued_at: issuedAt,
    sig: null,
  }
  // Go uses `omitempty` on expires_at: 0 must be ABSENT, not encoded as 0.
  if (expiresAt !== 0n) obj.expires_at = expiresAt
  return signObject(obj, parentPriv, TYPE_DEVICE_DELEGATION) as unknown as DeviceDelegation
}

/**
 * Delegate a per-tab session key under this device key, so events signed by the
 * session key chain session → device → member root. Without this a session key
 * is an orphan that no verifier can place.
 */
export function signSessionDelegation(
  sessionPub: Uint8Array,
  devicePub: Uint8Array,
  devicePriv: Uint8Array,
  scope: string,
  expiresAt: bigint,
): SessionDelegation {
  if (sessionPub.length !== 32 || devicePub.length !== 32) {
    throw new Error('session and device pubkeys must be 32 bytes')
  }
  return signObject(
    {
      type: TYPE_SESSION_DELEGATION,
      session_pub: sessionPub,
      device_pub: devicePub,
      scope,
      expires_at: expiresAt,
      sig: null,
    },
    devicePriv,
    TYPE_SESSION_DELEGATION,
  ) as unknown as SessionDelegation
}

/**
 * Mint the revocation that retires a device. The revoker must be an ANCESTOR of
 * the target — its parent, a grandparent, or the member root — which verifiers
 * enforce; signing with the wrong key produces an object everyone ignores.
 *
 * Revoking a device also takes down every device paired FROM it, since their
 * chains run through it. Show the caller `subtreeOf` before confirming.
 */
export function revokeDevice(
  devicePub: Uint8Array,
  revokerPub: Uint8Array,
  revokerPriv: Uint8Array,
  revokedAt: bigint,
): DeviceRevoke {
  if (devicePub.length !== 32 || revokerPub.length !== 32) {
    throw new Error('device and revoker pubkeys must be 32 bytes')
  }
  if (samePub(devicePub, revokerPub)) {
    throw new Error('a device cannot revoke itself (a revoke binds only from an ancestor)')
  }
  return signObject(
    {
      type: TYPE_DEVICE_REVOKE,
      device_pub: devicePub,
      revoker_pub: revokerPub,
      revoked_at: revokedAt,
      sig: null,
    },
    revokerPriv,
    TYPE_DEVICE_REVOKE,
  ) as unknown as DeviceRevoke
}

/** Verify a device delegation against the parent it names. Proves only that the
 *  parent admitted this device — NOT that the parent had standing to. Placing the
 *  parent in a tree that terminates at a member root is the chain walk's job (see
 *  directory.svelte.ts). */
export function verifyDeviceDelegation(dd: DeviceDelegation): boolean {
  const sig = dd.sig
  if (!sig || sig.length !== 64 || dd.parent_pub?.length !== 32) return false
  try {
    return ed25519.verify(
      sig,
      signingBytes(dd as unknown as Record<string, unknown>, TYPE_DEVICE_DELEGATION),
      dd.parent_pub,
    )
  } catch {
    return false
  }
}

/**
 * Vouch an agent to its operator: "this device (mine) says this agent belongs
 * to this operator." Signed by the delegator's key — no member-root words, so
 * this runs from any logged-in device.
 *
 * The operator MUST be the agent's attested operated_by at verify time; a
 * vouch naming anyone else is void. Minting still accepts any 32-byte operator
 * (the check happens against the attestation, where transfer voids old
 * vouches) — but minting without one is meaningless, so it is refused here.
 */
export function issueAgentVouch(
  agentPub: Uint8Array,
  delegatorPub: Uint8Array,
  delegatorPriv: Uint8Array,
  operatorPub: Uint8Array,
  issuedAt: bigint,
  expiresAt: bigint = 0n,
): AgentDelegation {
  if (agentPub.length !== 32) throw new Error('agent pubkey must be 32 bytes')
  if (delegatorPub.length !== 32) throw new Error('delegator pubkey must be 32 bytes')
  if (operatorPub.length !== 32) throw new Error('operator pubkey must be 32 bytes')
  if (samePub(agentPub, delegatorPub)) throw new Error('a key cannot vouch itself as an agent')
  if (expiresAt !== 0n && expiresAt <= issuedAt) {
    throw new Error('expires_at must be after issued_at')
  }
  const obj: Record<string, unknown> = {
    type: TYPE_AGENT_DELEGATION,
    agent_pub: agentPub,
    delegator_pub: delegatorPub,
    operator_pub: operatorPub,
    issued_at: issuedAt,
    sig: null,
  }
  // Go uses `omitempty` on expires_at: 0 must be ABSENT, not encoded as 0.
  if (expiresAt !== 0n) obj.expires_at = expiresAt
  return signObject(obj, delegatorPriv, TYPE_AGENT_DELEGATION) as unknown as AgentDelegation
}

/**
 * Withdraw the delegator's OWN vouch for an agent. Self-withdrawal is the only
 * valid shape — signing with anyone else's key produces an object every
 * verifier ignores. Withdrawing every vouch un-proves the agent with no path
 * back by itself.
 */
export function withdrawVouch(
  agentPub: Uint8Array,
  delegatorPub: Uint8Array,
  delegatorPriv: Uint8Array,
  withdrawnAt: bigint,
): VouchWithdraw {
  if (agentPub.length !== 32) throw new Error('agent pubkey must be 32 bytes')
  if (delegatorPub.length !== 32) throw new Error('delegator pubkey must be 32 bytes')
  return signObject(
    {
      type: TYPE_VOUCH_WITHDRAW,
      agent_pub: agentPub,
      delegator_pub: delegatorPub,
      withdrawn_at: withdrawnAt,
      sig: null,
    },
    delegatorPriv,
    TYPE_VOUCH_WITHDRAW,
  ) as unknown as VouchWithdraw
}

/** Verify a vouch against the delegator device that signed it. Proves only
 *  that the delegator vouched — NOT that it belongs to the named operator
 *  (the chain walk's job) or that the agent still names that operator (the
 *  attestation's job). */
export function verifyAgentDelegation(d: AgentDelegation): boolean {
  const sig = d.sig
  if (!sig || sig.length !== 64 || d.delegator_pub?.length !== 32) return false
  try {
    return ed25519.verify(
      sig,
      signingBytes(d as unknown as Record<string, unknown>, TYPE_AGENT_DELEGATION),
      d.delegator_pub,
    )
  } catch {
    return false
  }
}

/** Verify a withdrawal against the delegator withdrawing its own vouch. */
export function verifyVouchWithdraw(w: VouchWithdraw): boolean {
  const sig = w.sig
  if (!sig || sig.length !== 64 || w.delegator_pub?.length !== 32) return false
  try {
    return ed25519.verify(
      sig,
      signingBytes(w as unknown as Record<string, unknown>, TYPE_VOUCH_WITHDRAW),
      w.delegator_pub,
    )
  } catch {
    return false
  }
}

/**
 * Does any withdrawal cover this vouch — signed by the vouch's own delegator,
 * naming this agent, timestamped at or after the vouch's issuance? A withdraw
 * kills vouches issued at or before it; a later re-vouch is live, so
 * withdrawing can never permanently lock an operator out of re-proving.
 */
export function vouchWithdrawn(vouch: AgentDelegation, withdraws: VouchWithdraw[]): boolean {
  for (const w of withdraws) {
    if (!verifyVouchWithdraw(w)) continue
    if (!samePub(w.agent_pub, vouch.agent_pub) || !samePub(w.delegator_pub, vouch.delegator_pub)) {
      continue
    }
    if (w.withdrawn_at >= vouch.issued_at) return true
  }
  return false
}

// --- handoff bundle ----------------------------------------------------------
//
// The show-once artifact a human hands an agent harness: everything the
// harness needs to bootstrap as the agent, and nothing else. `cairn:agent:1:`
// + base64url(det-CBOR). The agent's root SEED is the only secret in it —
// treat it like a password. It is also the recovery: the same seed re-derives
// the root and (via standaloneDeviceKey) the device, so keep it somewhere safe.

export const BUNDLE_PREFIX = 'cairn:agent:1:'

export interface HandoffBundle {
  /** 32-byte agent root seed. THE secret — shown once, never persisted by us. */
  agent_seed: Uint8Array
  /** Relay base URL the harness dials (e.g. https://relay:8099). */
  relay_url: string
  /** Relay pubkey the harness pins. */
  relay_pub: Uint8Array
  /** Invite for the agent on an invite-only relay; '' on an open one. */
  invite: string
  /** The agent's objects, so the harness can verify AND publish them itself. */
  attestation: Uint8Array
  device_delegation: Uint8Array
  vouch: Uint8Array
  /** Display convenience only — the attestation names the agent. */
  agent_name: string
}

/** Mint the handoff bundle. The seed MUST be the agent root's 32-byte seed. */
export function encodeHandoffBundle(b: HandoffBundle): string {
  if (b.agent_seed.length !== 32) throw new Error('agent seed must be 32 bytes')
  if (b.relay_pub.length !== 32) throw new Error('relay pubkey must be 32 bytes')
  const body = cborEncode({
    agent_seed: b.agent_seed,
    relay_url: b.relay_url,
    relay_pub: b.relay_pub,
    invite: b.invite,
    attestation: b.attestation,
    device_delegation: b.device_delegation,
    vouch: b.vouch,
    agent_name: b.agent_name,
  } as CborValue)
  return BUNDLE_PREFIX + b64url(body)
}

/**
 * Decode AND validate a bundle: structure, cross-checks (seed → root →
 * device → delegation; vouch operator == attested operated_by), and every
 * signature. A harness MUST adopt through this, never by trusting the bytes —
 * the bundle crossed a clipboard/QR gap and may be corrupt or hostile.
 */
export function parseHandoffBundle(s: string): HandoffBundle {
  const t = s.trim()
  if (!t.startsWith(BUNDLE_PREFIX)) throw new Error('Not a Cairn agent bundle.')
  let raw: unknown
  try {
    raw = cborDecode(unb64url(t.slice(BUNDLE_PREFIX.length)))
  } catch {
    throw new Error('Malformed agent bundle.')
  }
  const o = raw as Record<string, unknown>
  const bytes = (k: string, n: number): Uint8Array => {
    const v = o[k]
    if (!(v instanceof Uint8Array) || v.length !== n) throw new Error(`Agent bundle: ${k} must be ${n} bytes.`)
    return v
  }
  const seed = bytes('agent_seed', 32)
  const relayPub = bytes('relay_pub', 32)
  if (typeof o['relay_url'] !== 'string' || !o['relay_url']) throw new Error('Agent bundle: missing relay_url.')
  if (typeof o['invite'] !== 'string') throw new Error('Agent bundle: missing invite.')
  if (typeof o['agent_name'] !== 'string') throw new Error('Agent bundle: missing agent_name.')
  const attRaw = o['attestation']
  const ddRaw = o['device_delegation']
  const vouchRaw = o['vouch']
  if (!(attRaw instanceof Uint8Array) || !(ddRaw instanceof Uint8Array) || !(vouchRaw instanceof Uint8Array)) {
    throw new Error('Agent bundle: missing identity objects.')
  }

  // Cross-checks: the objects must describe THIS seed, not just any agent.
  const rootPub = ed25519.getPublicKey(seed)
  const device = standaloneDeviceKey(seed)
  let att: IdentityAttestation
  let dd: DeviceDelegation
  let vouch: AgentDelegation
  try {
    att = cborDecode(attRaw) as unknown as IdentityAttestation
    dd = cborDecode(ddRaw) as unknown as DeviceDelegation
    vouch = cborDecode(vouchRaw) as unknown as AgentDelegation
  } catch {
    throw new Error('Agent bundle: undecodable identity objects.')
  }
  if (!verifyAttestation(att) || !samePub(att.pubkey, rootPub)) {
    throw new Error('Agent bundle: attestation does not verify for this seed.')
  }
  if (att.kind !== 'agent') throw new Error('Agent bundle: attestation is not kind=agent.')
  if (!verifyDeviceDelegation(dd) || !samePub(dd.device_pub, device.pub) || !samePub(dd.parent_pub, rootPub)) {
    throw new Error('Agent bundle: device delegation does not match this seed.')
  }
  if (!verifyAgentDelegation(vouch) || !samePub(vouch.agent_pub, rootPub)) {
    throw new Error('Agent bundle: vouch does not verify for this agent.')
  }
  if (!samePub(vouch.operator_pub, att.operated_by!)) {
    throw new Error('Agent bundle: vouch names a different operator than the attestation.')
  }
  return {
    agent_seed: seed,
    relay_url: o['relay_url'] as string,
    relay_pub: relayPub,
    invite: o['invite'] as string,
    attestation: attRaw,
    device_delegation: ddRaw,
    vouch: vouchRaw,
    agent_name: o['agent_name'] as string,
  }
}
