// Reactive wrapper over the persistent identity vault. Separate from AppState
// (rooms/DAG) because identity outlives any room and is read by the shell before
// the app is usable at all.

import {
  loadIdentity,
  forgetIdentity,
  resetDevice,
  hex,
  pendingDevicePairing,
  completeDevicePairing,
  recoverWithAttestation,
  type Identity,
} from './vault'
import {
  memberRootFromMnemonic,
  signSessionDelegation,
  type SessionDelegation,
  type DeviceDelegation,
  type IdentityAttestation,
} from './identity'
import { sessionPub } from './crypto'
import { directory } from './directory.svelte'
import { roomStore } from './rooms.svelte'
import { cairn } from './api'
import { encode as cborEncode, decode as cborDecode, type CborValue } from './cbor'

/** Decode one identity-log object, or null if it is malformed. */
function decodeIdentityObject<T>(b: Uint8Array): T | null {
  try {
    return cborDecode(b) as T
  } catch {
    return null
  }
}

/** Session delegations are short-lived; a tab re-mints one each load. */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000

class IdentityState {
  current = $state<Identity | null>(null)
  /** This tab's session delegation, published so peers can walk our chain. */
  sessionDelegation: SessionDelegation | null = null
  /** False until the first load attempt completes, so the shell can avoid
   *  flashing onboarding at someone who is already set up. */
  ready = $state(false)

  /** Display name for a sender pubkey. Only our OWN key resolves today: other
   *  members' attestations arrive with the identity log, which does not sync yet
   *  (README caveats). Everyone else stays an honest key stub rather than a
   *  guessed name. */
  nameFor(senderPubHex: string, myPubHex: string): string {
    if (this.current && senderPubHex === myPubHex) return this.current.displayName
    const t = directory.get(senderPubHex)
    switch (t.state) {
      case 'verified':
        return t.name
      case 'revoked':
        // Named, but flagged: the message is real history from a key its member
        // has since disowned. Hiding that would be dishonest in both directions.
        return `${t.name} (revoked device)`
      default:
        // 'unknown' (not resolved yet) and 'untrusted' (verifies, but belongs to
        // a household we don't accept) both stay key stubs. Showing a stranger's
        // self-chosen display name is exactly how impersonation would work.
        return 'cairn:' + senderPubHex.slice(0, 6)
    }
  }

  /** True once this member's own device key exists — used to mark pre-identity
   *  history, which was signed by throwaway keys that chain to nothing. */
  get devicePubHex(): string {
    return this.current ? hex(this.current.devicePub) : ''
  }

  load() {
    this.current = loadIdentity()
    this.ready = true
    this.bindSession()
    directory.setHousehold(this.current?.householdPub ?? null)
    void this.publish()
    void roomStore.refresh()
  }

  /**
   * Push our attestation, device delegation and session delegation to the
   * carrier so other members can resolve us. Idempotent — the server stores by
   * content address, so re-publishing on every load is a no-op after the first.
   *
   * Best-effort: offline is a normal state, and failing to publish only means
   * peers see a key stub instead of a name.
   */
  async publish() {
    const id = this.current
    if (!id) return
    const objs: Record<string, unknown>[] = [
      id.attestation as unknown as Record<string, unknown>,
      id.delegation as unknown as Record<string, unknown>,
    ]
    if (this.sessionDelegation) {
      objs.push(this.sessionDelegation as unknown as Record<string, unknown>)
    }
    for (const o of objs) await this.publishObject(o)
  }

  /**
   * Publish one signed identity-log object to the carrier.
   *
   * Returns whether it landed. Revocations MUST surface that: a revoke that
   * silently failed to publish leaves every other member still trusting a key
   * its owner believes they killed, which is worse than an error.
   */
  async publishObject(obj: Record<string, unknown>): Promise<boolean> {
    try {
      await cairn.putIdentityObject({ cbor: cborEncode(obj as CborValue) })
      return true
    } catch {
      return false
    }
  }

  /**
   * Poll for this device's pairing approval.
   *
   * The new device holds only its own key, so it asks the carrier to resolve
   * that key and watches for a delegation chain plus an attestation to appear —
   * published by whichever device approved the scan. Everything is re-verified
   * locally in `completeDevicePairing`; the carrier is a mailbox here, not an
   * authority.
   *
   * Returns the identity once paired, or null while still waiting. Errors from
   * a bad or mismatched approval are thrown, because those need the human to see
   * them rather than being retried forever.
   */
  async pollPairing(): Promise<Identity | null> {
    const pending = pendingDevicePairing()
    if (!pending) return null

    let res
    try {
      res = await cairn.resolveSender({ senderPub: pending.devicePub })
    } catch {
      return null // offline; the caller polls again
    }
    const chain = (res.deviceDelegations ?? [])
      .map((b) => decodeIdentityObject<DeviceDelegation>(b))
      .filter((d): d is DeviceDelegation => d !== null)
    const att = res.attestation
      ? decodeIdentityObject<IdentityAttestation>(res.attestation)
      : null
    if (!chain.length || !att) return null // approval hasn't landed yet

    const id = completeDevicePairing(chain, att)
    this.set(id)
    return id
  }

  /**
   * Recover a NON-founder from their member phrase alone, by fetching the
   * attestation the household signed for them when they joined.
   *
   * They never saw the household phrase, so they cannot re-attest themselves —
   * but they do not need to: the attestation is already published, and it is
   * verified locally before anything is written.
   */
  async recoverFromCarrier(memberMnemonic: string, deviceLabel: string): Promise<Identity> {
    const memberPub = memberRootFromMnemonic(memberMnemonic).pub
    let res
    try {
      res = await cairn.resolveSender({ senderPub: memberPub })
    } catch {
      throw new Error(
        'Cannot reach the carrier to look up your account. Recovery this way needs a ' +
          'connection — or use the household phrase, if you have it.',
      )
    }
    const att = res.attestation
      ? decodeIdentityObject<IdentityAttestation>(res.attestation)
      : null
    if (!att) {
      throw new Error(
        'No account was found for those words on this server. Either the phrase is wrong, ' +
          'or nobody has published your attestation here — ask a household member to ' +
          'invite you again.',
      )
    }
    const restored = recoverWithAttestation(memberMnemonic, att, deviceLabel)
    restored.commit()
    this.set(restored.identity)
    return restored.identity
  }

  set(id: Identity) {
    this.current = id
    this.bindSession()
    directory.setHousehold(id.householdPub)
    directory.clear() // names resolved under a previous identity no longer apply
    void this.publish()
    void roomStore.refresh()
  }

  /** Delegate this tab's session key under the device key, so events it signs
   *  chain session → device → member → household. Called after load/set because
   *  the session key slot is scoped to the device key (crypto.ts). */
  bindSession() {
    const id = this.current
    if (!id) return
    try {
      const sd = signSessionDelegation(
        sessionPub(),
        id.devicePub,
        id.devicePriv,
        'chat',
        BigInt(Date.now() + SESSION_TTL_MS),
      )
      this.sessionDelegation = sd
      sessionStorage.setItem(
        'cairn-session-delegation',
        JSON.stringify({ session: hex(sd.session_pub), device: hex(sd.device_pub) }),
      )
    } catch {
      // A missing delegation degrades to "unverifiable sender", not a crash.
    }
  }

  forget() {
    forgetIdentity()
    this.current = null
  }

  /** Full device reset: keys, room keys, cache. Reloads so every module drops
   *  the state it read at startup — a partial in-memory reset is how stale keys
   *  come back to life. */
  async reset() {
    await resetDevice()
    this.current = null
    directory.clear()
    roomStore.clear()
    location.reload()
  }
}

export const identity = new IdentityState()
