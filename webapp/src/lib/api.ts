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
