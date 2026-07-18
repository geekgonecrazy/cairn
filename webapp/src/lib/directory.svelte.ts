// Sender directory: resolves a sender pubkey to an ATTESTED display name by
// fetching its identity-log chain and verifying it locally.
//
// The server is a carrier, not an authority — it hands back signed objects and
// we check every signature here. A name is only shown once the chain verifies
// AND terminates at a household we accept; anything else stays an honest key
// stub, because a name is a trust claim and a wrong one is worse than none.

import { cairn, hex } from './api'
import {
  verifyAttestation,
  type IdentityAttestation,
  type DeviceDelegation,
  type DeviceRevoke,
  type SessionDelegation,
} from './identity'
import { decode as cborDecode } from './cbor'
import { ed25519 } from '@noble/curves/ed25519.js'
import { encode as cborEncode, type CborValue } from './cbor'

export type SenderTrust =
  | { state: 'unknown' } // not resolved yet, or the server has no chain for it
  | { state: 'verified'; name: string; memberPub: Uint8Array; householdPub: Uint8Array }
  | { state: 'revoked'; name: string }
  | { state: 'untrusted'; reason: string } // resolved but does NOT belong to our household

function verifyDetached(
  obj: Record<string, unknown>,
  signerPub: Uint8Array,
): boolean {
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
  private inflight = new Set<string>()

  /** Our household root — the only origin whose attestations we accept. */
  private trustedHousehold: Uint8Array | null = null

  setHousehold(pub: Uint8Array | null) {
    this.trustedHousehold = pub
  }

  get(senderPubHex: string): SenderTrust {
    return this.entries[senderPubHex] ?? { state: 'unknown' }
  }

  /** Resolve a sender if we haven't already. Safe to call on every render. */
  resolve(senderPub: Uint8Array) {
    const key = hex(senderPub)
    if (this.entries[key] || this.inflight.has(key)) return
    this.inflight.add(key)
    void this.fetch(senderPub, key).finally(() => this.inflight.delete(key))
  }

  private async fetch(senderPub: Uint8Array, key: string) {
    let res
    try {
      res = await cairn.resolveSender({ senderPub })
    } catch {
      return // offline or unknown; stays 'unknown' and retries on next load
    }

    const att = dec<IdentityAttestation>(res.attestation)
    const dd = dec<DeviceDelegation>(res.deviceDelegation)
    const sd = dec<SessionDelegation>(res.sessionDelegation)
    const dr = dec<DeviceRevoke>(res.deviceRevoke)

    // Walk the chain ourselves: session → device → member → household. Every
    // hop is checked; a break anywhere means we show no name.
    let devicePub = senderPub
    if (sd) {
      if (!verifyDetached(sd as unknown as Record<string, unknown>, sd.device_pub)) return
      if (hex(sd.session_pub) !== key) return
      devicePub = sd.device_pub
    }
    if (!dd || !verifyDetached(dd as unknown as Record<string, unknown>, dd.member_pub)) return
    if (hex(dd.device_pub) !== hex(devicePub)) return
    if (!att || !verifyAttestation(att)) return
    if (hex(att.pubkey) !== hex(dd.member_pub)) return

    // Revocation wins, and must be signed by the member that holds the device.
    if (dr && verifyDetached(dr as unknown as Record<string, unknown>, dr.member_pub)) {
      if (hex(dr.member_pub) === hex(dd.member_pub) && hex(dr.device_pub) === hex(devicePub)) {
        this.entries = { ...this.entries, [key]: { state: 'revoked', name: att.display_name } }
        return
      }
    }

    // The chain is internally sound — but soundness is not membership. An
    // attestation's origin is self-declared, so a stranger's household verifies
    // its own chain perfectly. Only OUR household earns a name.
    if (!this.trustedHousehold || hex(att.origin) !== hex(this.trustedHousehold)) {
      this.entries = {
        ...this.entries,
        [key]: { state: 'untrusted', reason: 'not in your household' },
      }
      return
    }

    this.entries = {
      ...this.entries,
      [key]: {
        state: 'verified',
        name: att.display_name,
        memberPub: att.pubkey,
        householdPub: att.origin,
      },
    }
  }

  // --- member roots (room rosters) ---------------------------------------
  //
  // Distinct from resolve(), which takes a SENDING key and walks up the chain.
  // A roster stores member roots, which never sign events themselves, so there
  // is no chain to walk — we look the attestation up directly.

  /** memberPubHex → attested display name. */
  private memberNames = $state<Record<string, string>>({})
  private memberInflight = new Set<string>()

  /** Attested name for a member root, or '' if we can't verify one. */
  memberName(memberPubHex: string): string {
    return this.memberNames[memberPubHex] ?? ''
  }

  resolveMember(memberPub: Uint8Array) {
    const key = hex(memberPub)
    if (this.memberNames[key] !== undefined || this.memberInflight.has(key)) return
    this.memberInflight.add(key)
    void (async () => {
      try {
        const res = await cairn.resolveSender({ senderPub: memberPub })
        const att = dec<IdentityAttestation>(res.attestation)
        // Same rule as sender names: the attestation must verify AND belong to
        // our household, or we show a key stub rather than a self-chosen name.
        if (
          att &&
          verifyAttestation(att) &&
          hex(att.pubkey) === key &&
          this.trustedHousehold &&
          hex(att.origin) === hex(this.trustedHousehold)
        ) {
          this.memberNames = { ...this.memberNames, [key]: att.display_name }
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
  }
}

export const directory = new Directory()
