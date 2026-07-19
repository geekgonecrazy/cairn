// The Cairn client-side API surface: a typed ConnectRPC client for the unary
// calls (SendEvent / Sync / History / GetIdentityObject) plus a helper that
// opens the SSE realtime stream and yields decoded Events.
//
// The server is convenience, not authority — the client re-syncs via Sync on
// every (re)connect, so a dropped SSE frame is never a lost message.

import { createClient, type Client, ConnectError, Code } from '@connectrpc/connect'
import { createConnectTransport } from '@connectrpc/connect-web'
import { fromBinary } from '@bufbuild/protobuf'
import { CairnService, EventSchema, type Event } from '../gen/cairn_pb'

// baseUrl is empty → requests go to the same origin at the server root
// (/cairn.v1.CairnService/*). In dev, Vite proxies that to cairnd.
const transport = createConnectTransport({ baseUrl: '' })

export const cairn: Client<typeof CairnService> = createClient(CairnService, transport)

/**
 * True when the carrier REFUSED an event because it lacks identity objects it can
 * be given — the household isn't founded on this carrier yet, or a chain link we
 * haven't pushed. The recovery is to publish our identity and retry (the chain
 * gate's FailedPrecondition). This is distinct from a TERMINAL denial
 * (PermissionDenied: revoked / untrusted / expired), which retrying can't fix.
 */
export function needsIdentityPublish(e: unknown): boolean {
  return e instanceof ConnectError && e.code === Code.FailedPrecondition
}

/** True when the carrier permanently rejected the sender (revoked / untrusted /
 *  expired). No retry will help; surface it rather than silently queueing. */
export function isSenderRejected(e: unknown): boolean {
  return e instanceof ConnectError && e.code === Code.PermissionDenied
}

/**
 * Turn a send failure into something a human can act on, ALWAYS including the
 * server's own message rather than replacing it with a friendly guess.
 *
 * The rule here is that the carrier's reason is the most useful thing we have —
 * "chain does not terminate at a trusted root" tells you exactly what is wrong,
 * where "couldn't send" tells you nothing and sends you reading logs. We add
 * context about what to DO, and keep the raw text.
 */
export function describeSendFailure(e: unknown): string {
  if (!(e instanceof ConnectError)) {
    return e instanceof Error ? e.message : String(e)
  }
  const raw = e.rawMessage || e.message

  if (e.code === Code.PermissionDenied) {
    // Terminal: the carrier will never accept this sender as-is. Retrying is
    // pointless, so say what it actually means.
    if (/trusted root|untrusted/i.test(raw)) {
      return (
        `The server does not trust your household, so it rejected this. ` +
        `That usually means it adopted a DIFFERENT household first — e.g. this ` +
        `identity was set up again after the server had already seen another one. ` +
        `Pin your household root in the server's trustedRoots, or reset its database. ` +
        `(server: ${raw})`
      )
    }
    if (/revoked/i.test(raw)) {
      return `This device has been revoked, so the server rejected it. (server: ${raw})`
    }
    if (/expired/i.test(raw)) {
      return `Your session has expired — reload to mint a new one. (server: ${raw})`
    }
    return `The server rejected this permanently. (server: ${raw})`
  }
  if (e.code === Code.FailedPrecondition) {
    return `The server could not verify you yet, even after publishing your identity. (server: ${raw})`
  }
  if (e.code === Code.Unavailable) {
    return `Can't reach the server — it may be stopped. (server: ${raw})`
  }
  return `Send failed: ${raw}`
}

/** Open the realtime SSE stream. Calls onEvent for each Event the server pushes. */
export function subscribe(onEvent: (ev: Event) => void, onOpen?: () => void): () => void {
  const es = new EventSource('/v1/subscribe')
  if (onOpen) es.addEventListener('open', () => onOpen())
  es.addEventListener('cairn', (e) => {
    const bytes = base64ToBytes((e as MessageEvent).data)
    onEvent(fromBinary(EventSchema, bytes))
  })
  return () => es.close()
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Hex-encode bytes for display / keys (event ids, pubkeys). */
export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** UTF-8 encode a string to bytes (room ids etc.). */
export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}
