// Crypto-conformance check: recompute the canonical event_id for the same fixed
// vectors asserted by the Go test (event/conformance_test.go) and confirm the
// browser's CBOR + BLAKE3 produce byte-identical ids. Run: `npm run conformance`.
// Any drift here means Go↔browser event_ids would diverge and events would fail
// to verify — a release-blocking regression.
import { blake3 } from '@noble/hashes/blake3.js'
import { encode as cborEncode, decode as cborDecode } from '../src/lib/cbor.ts'

const rep = (b: number) => new Uint8Array(32).fill(b)
const utf8 = (s: string) => new TextEncoder().encode(s)
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const cmp = (a: Uint8Array, b: Uint8Array) => {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return a.length - b.length
}

function eventId(
  sender: Uint8Array,
  room: Uint8Array,
  ts: bigint,
  parents: Uint8Array[],
  type: number,
  payload: Uint8Array,
): string {
  const sorted = [...parents].sort(cmp)
  return hex(blake3(cborEncode([sender, room, ts, sorted, type, payload])))
}

const vectors = [
  {
    id: eventId(rep(0x01), utf8('general'), 1720000000000n, [], 1, utf8('hello')),
    want: '1a0c4f0f94d12884427a8597e6c73a032982ec4dc00a846f055e3d4a38a2b981',
  },
  {
    id: eventId(rep(0x01), utf8('general'), 1720000000000n, [rep(0x03), rep(0x02)], 4, new Uint8Array()),
    want: '06281b061cca3fd6d097a851406073d557dee7cb5013443c9352fe3c17f6b79c',
  },
  {
    id: eventId(rep(0xab), utf8(''), 0n, [rep(0x02)], 50, new Uint8Array([0xde, 0xad, 0xbe, 0xef])),
    want: '9f6a473a69862f4077c25656c174179e4e5d6c703ecce91dbf3baea32b55246f',
  },
]

// Declaration vector: a nested MAP, mirroring event/conformance_test.go.
//
// The event vectors are arrays of bytes and ints and never exercise map-key
// ordering. Inlay declarations ARE maps, and decl_cid is BLAKE3 over that
// encoding — if Go and the browser order keys differently, every declaration an
// agent publishes fails its hash check on arrival and degrades to a text line.
const declarationVector = {
  name: 'poll',
  version: 1,
  authorless: true,
  schema: {
    role: 'group',
    header: { role: 'text', bind: 'question', emphasis: 'title' },
    children: [
      {
        role: 'list', bind: 'options', empty: 'No options.',
        item: {
          role: 'group',
          children: [
            { role: 'text', bind: 'label' },
            { role: 'progress_fraction', bind: 'share', polarity: 'neutral' },
          ],
        },
      },
    ],
  },
  actions: [{ id: 'vote', label: 'Vote', kind: 'immediate', variant: 'primary' }],
}
const DECL_CID_WANT = 'b732d156878e8bb353ab31dd32b15be7de9da785ebff5da360f0702d875b7ede'

const declEncoded = cborEncode(declarationVector as never)
const declCid = hex(blake3(declEncoded))
// The round-trip learnDeclaration actually performs: decode what arrived,
// re-encode it, hash that. Stability here is what makes a decl_cid verifiable.
const declRoundTrip = hex(cborEncode(cborDecode(declEncoded) as never))
const declOK = declCid === DECL_CID_WANT
const rtOK = declRoundTrip === hex(declEncoded)

let ok = declOK && rtOK
vectors.forEach((v, i) => {
  const pass = v.id === v.want
  ok &&= pass
  console.log(`V${i + 1} ${pass ? 'OK' : 'FAIL'}  ${v.id}${pass ? '' : `\n     want ${v.want}`}`)
})
console.log(`DECL ${declOK ? 'OK' : 'FAIL'}  ${declCid}${declOK ? '' : `\n     want ${DECL_CID_WANT}`}`)
console.log(`DECL ${rtOK ? 'OK' : 'FAIL'}  decode -> re-encode is byte-stable`)
console.log(ok ? 'CONFORMANCE PASS: browser event_ids + decl_cids match Go' : 'CONFORMANCE FAIL')
process.exit(ok ? 0 : 1)
