// Browser half of the Cairn identity chain — the exact mirror of Go's
// `identity` package. See identity/household.go for the authoritative comments
// on the household-root shape; this file must stay byte-compatible with it.
//
// PARITY IS LOAD-BEARING. A household bootstrapped in the browser has to derive
// the same root pubkey, and sign attestations over the same canonical bytes, as
// Go — otherwise events signed here fail chain-walk verification server-side.
// `npm run conformance` asserts the golden vectors that prove it; do not change
// a derivation here without re-running it.

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

/** Domain separation label. MUST match identity/household.go. */
const HKDF_INFO_HOUSEHOLD_ROOT = 'cairn/household-root/v1'
const HKDF_INFO_MEMBER_ROOT = 'cairn/member-root/v1'

export type Kind = 'human' | 'agent' | 'service'

/**
 * Object type tags — part of the SIGNED bytes of every identity-log object.
 * MUST match identity/identity.go's Type* constants.
 *
 * Two jobs: parsing dispatches on the tag instead of decoding an object as each
 * candidate shape, and the signature is domain-separated so a session
 * delegation can never verify as a device delegation.
 */
export const TYPE_ATTESTATION = 'identity_attestation'
export const TYPE_DEVICE_DELEGATION = 'device_delegation'
export const TYPE_SESSION_DELEGATION = 'session_delegation'
export const TYPE_DEVICE_REVOKE = 'device_revoke'

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
 * change the derived household. Deliberately does NOT spell-correct — a typo
 * must fail the checksum rather than snap to a stranger's household.
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

// --- household root -------------------------------------------------------

/**
 * Derive the household root keypair from a mnemonic. Same words → same
 * household id, which is what makes recovery work.
 *
 * A different passphrase yields a DIFFERENT household rather than an error —
 * BIP-39's plausible-deniability property. Callers must surface the resulting
 * "nobody recognizes you" state legibly (see decisions.md).
 */
export function householdRootFromMnemonic(mnemonic: string, passphrase = ''): KeyPair {
  const err = validateMnemonicPhrase(mnemonic)
  if (err) throw new Error(err)
  const seed = mnemonicToSeedSync(normalizeMnemonic(mnemonic), passphrase)
  // Domain-separate before touching Ed25519 (mirrors Go's hkdf.New/ReadFull).
  const info = new TextEncoder().encode(HKDF_INFO_HOUSEHOLD_ROOT)
  const sk = hkdf(sha512, seed, undefined, info, 32)
  return { priv: sk, pub: ed25519.getPublicKey(sk) }
}

/**
 * Derive a MEMBER root keypair from that member's own mnemonic — a different
 * set of words from the household's.
 *
 * A member root is an offline apex, exactly like the household root: it signs
 * the member's FIRST device delegation and is then put away, never persisted.
 * Every device after that is paired from an existing device, which signs as
 * parent. That is what makes device revocation meaningful (a stolen device
 * holds no key that can admit a replacement) and why room keys wrap to DEVICE
 * keys rather than to this one.
 *
 * Domain-separated from the household derivation, so the same words can never
 * produce both and neither can forge the other.
 */
export function memberRootFromMnemonic(mnemonic: string, passphrase = ''): KeyPair {
  const err = validateMnemonicPhrase(mnemonic)
  if (err) throw new Error(err)
  const seed = mnemonicToSeedSync(normalizeMnemonic(mnemonic), passphrase)
  const info = new TextEncoder().encode(HKDF_INFO_MEMBER_ROOT)
  const sk = hkdf(sha512, seed, undefined, info, 32)
  return { priv: sk, pub: ed25519.getPublicKey(sk) }
}

/** A freshly minted member root: the words are shown ONCE and never stored. */
export function newMemberRoot(): { mnemonic: string; keys: KeyPair } {
  const mnemonic = newMnemonic()
  return { mnemonic, keys: memberRootFromMnemonic(mnemonic) }
}

export interface Household {
  rootPub: Uint8Array
  mnemonic: string
}

/** Create a new household. The mnemonic must be shown once and confirmed. */
export function bootstrapHousehold(): Household {
  const mnemonic = newMnemonic()
  return { rootPub: householdRootFromMnemonic(mnemonic).pub, mnemonic }
}

// --- identity-log objects -------------------------------------------------

export interface IdentityAttestation {
  type: string // always TYPE_ATTESTATION; signed
  pubkey: Uint8Array
  kind: Kind
  origin: Uint8Array
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
 * Mint the attestation binding a member root to this household, signed by the
 * root re-derived from the mnemonic. kind and display_name are IMMUTABLE once
 * attested — this is not an editable profile.
 */
export function provisionMember(
  mnemonic: string,
  passphrase: string,
  memberPub: Uint8Array,
  kind: Kind,
  displayName: string,
  operatedBy: Uint8Array | null,
  issuedAt: bigint,
): IdentityAttestation {
  if (memberPub.length !== 32) throw new Error('member pubkey must be 32 bytes')
  if (kind === 'agent') {
    if (!operatedBy || operatedBy.length !== 32) {
      throw new Error('an agent requires an operated_by member root')
    }
  } else if (operatedBy && operatedBy.length > 0) {
    throw new Error('operated_by is only valid for agents')
  }
  const root = householdRootFromMnemonic(mnemonic, passphrase)
  return signObject(
    {
      type: TYPE_ATTESTATION,
      pubkey: memberPub,
      kind,
      origin: root.pub,
      operated_by: operatedBy && operatedBy.length ? operatedBy : null,
      display_name: displayName,
      issued_at: issuedAt,
      sig: null,
    } as unknown as Record<string, unknown>,
    root.priv,
    TYPE_ATTESTATION,
  ) as unknown as IdentityAttestation
}

export function verifyAttestation(att: IdentityAttestation): boolean {
  return verifyObject(att as unknown as Record<string, unknown>, att.origin, TYPE_ATTESTATION)
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

// --- member provisioning (joining an existing household) ------------------
//
// A household is bootstrapped ONCE. Everyone after the founder JOINS it: the
// newcomer generates a member key and shows a join code; someone holding the
// household's 24 words attests it and hands back the attestation. The household
// root private key never leaves the inviter's re-derivation, and the newcomer's
// member private key never leaves their device. Nothing secret crosses.

const JOIN_PREFIX = 'cairn:join:'
const ATT_PREFIX = 'cairn:att:'

export interface JoinRequest {
  version: number
  memberPub: Uint8Array
  /** Self-reported and UNATTESTED until the inviter signs it. */
  displayName: string
}

export function newJoinRequest(memberPub: Uint8Array, displayName: string): JoinRequest {
  if (memberPub.length !== 32) throw new Error('member pubkey must be 32 bytes')
  if (/[:\n]/.test(displayName)) throw new Error("name must not contain ':' or newlines")
  return { version: PAIRING_VERSION, memberPub, displayName }
}

export function encodeJoinRequest(j: JoinRequest): string {
  return `${JOIN_PREFIX}${j.version}:${b64url(j.memberPub)}:${j.displayName}`
}

export function parseJoinRequest(s: string): JoinRequest {
  const t = s.trim()
  if (!t.startsWith(JOIN_PREFIX)) throw new Error('Not a Cairn join code.')
  const rest = t.slice(JOIN_PREFIX.length)
  const a = rest.indexOf(':')
  const b = rest.indexOf(':', a + 1)
  if (a < 0 || b < 0) throw new Error('Malformed join code.')
  const version = Number(rest.slice(0, a))
  if (version !== PAIRING_VERSION) {
    throw new Error(`Unsupported join code version ${version}.`)
  }
  let pub: Uint8Array
  try {
    pub = unb64url(rest.slice(a + 1, b))
  } catch {
    throw new Error('Malformed join code.')
  }
  if (pub.length !== 32) throw new Error('Join key must be 32 bytes.')
  return { version, memberPub: pub, displayName: rest.slice(b + 1) }
}

/** Serialize a signed attestation for hand-carrying back to the new member. */
export function encodeAttestation(att: IdentityAttestation): string {
  const payload = cborEncode({
    type: att.type,
    pubkey: att.pubkey,
    kind: att.kind,
    origin: att.origin,
    operated_by: att.operated_by,
    display_name: att.display_name,
    issued_at: att.issued_at,
    sig: att.sig,
  } as CborValue)
  return `${ATT_PREFIX}${PAIRING_VERSION}:${b64url(payload)}`
}

/**
 * Parse and VERIFY an attestation blob. Verification is not optional: the blob
 * arrives by copy-paste from another screen, so a bad signature here is the only
 * thing standing between a newcomer and a forged household membership.
 */
export function parseAttestation(s: string): IdentityAttestation {
  const t = s.trim()
  if (!t.startsWith(ATT_PREFIX)) throw new Error('Not a Cairn invite.')
  const rest = t.slice(ATT_PREFIX.length)
  const a = rest.indexOf(':')
  if (a < 0) throw new Error('Malformed invite.')
  if (Number(rest.slice(0, a)) !== PAIRING_VERSION) {
    throw new Error('Unsupported invite version.')
  }
  let decoded: Record<string, unknown>
  try {
    decoded = cborDecode(unb64url(rest.slice(a + 1))) as Record<string, unknown>
  } catch {
    throw new Error('Malformed invite — it may have been truncated when copied.')
  }
  const att = {
    type: decoded.type as string,
    pubkey: decoded.pubkey as Uint8Array,
    kind: decoded.kind as Kind,
    origin: decoded.origin as Uint8Array,
    operated_by: (decoded.operated_by ?? null) as Uint8Array | null,
    display_name: decoded.display_name as string,
    issued_at: decoded.issued_at as bigint,
    sig: decoded.sig as Uint8Array,
  }
  if (!(att.pubkey instanceof Uint8Array) || att.pubkey.length !== 32) {
    throw new Error('Invite is missing a valid member key.')
  }
  if (!verifyAttestation(att)) {
    throw new Error('This invite is not correctly signed by the household. Ask for a new one.')
  }
  return att
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
 * session key chain session → device → member → household. Without this a
 * session key is an orphan that no verifier can place.
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
 *  parent admitted this device — NOT that the parent had standing to. Placing
 *  the parent in a tree that reaches a trusted household root is the chain
 *  walk's job (see directory.svelte.ts). */
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
