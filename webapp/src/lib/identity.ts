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
import { encode as cborEncode, type CborValue } from './cbor'

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
