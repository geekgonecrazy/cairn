// Identity-conformance check: the browser's member-root derivation, self-attestation
// signing bytes, and pairing encoding must match Go's `identity` package EXACTLY.
// Golden values below were produced by Go (identity/conformance_test.go asserts the
// same constants).
//
// Any drift means a key derived in a browser signs over different bytes than Go,
// and its events fail chain-walk verification elsewhere. Release-blocking.
//
// Run: `npm run identity-conformance`.

import {
  memberRootFromMnemonic,
  newSelfAttestation,
  verifyAttestation,
  objectHash,
  newPairingRequest,
  encodePairingRequest,
  parsePairingRequest,
  fingerprint,
  validateMnemonicPhrase,
  normalizeMnemonic,
  newMnemonic,
  approvePairing,
  revokeDevice,
  issueAgentVouch,
  verifyAgentDelegation,
  withdrawVouch,
  verifyVouchWithdraw,
  standaloneDeviceKey,
  encodeHandoffBundle,
  parseHandoffBundle,
} from '../src/lib/identity.ts'
import { signGrant, signDeny, TYPE_GRANT, TYPE_DENY } from '../src/lib/approval.ts'
import { ed25519 } from '@noble/curves/ed25519.js'

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

// BIP-39 256-bit all-zero-entropy test vector.
const M =
  'abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon abandon abandon abandon abandon abandon abandon art'

const GOLDEN = {
  // v2: a member IS this key; there is no household root above it.
  memberRootPub: '5c76722a889dec8d4736408eb6e741787750a30f61c98fef5d29a7226e061b51',
  // A member's SELF-signed attestation (kind=human, "Sam", issued_at 1720000000000).
  attSig:
    '7697ffb5ef8b9d4c10c399cec91922ede6aa924959c9d2461221c017bd2e8ec1' +
    '16f73cfcc76013bc6d08e1c37cab303b831f140b903348324cf92985c347bc06',
  attHash: '4f433634bec07067d9673c629d9c812f401e6bf7ed797fcc16c0ccba0f1a1679',
  pairEncoded: "cairn:pair:1:oKGio6SlpqeoqaqrrK2ur7CxsrO0tba3uLm6u7y9vr8:Sam's phone",
  fingerprint: 'a0a1-a2a3-a4a5-a6a7',
  // Device delegation / revoke for device 0xa0..0xbf, signed by the member root.
  delegationSig:
    '325186565b8ea2c171b13e2ac665325ca42729db6df2e6682241c255a95752b3' +
    'd031c1e3732631127a480d6f3c8fcb823628d729b97e651eb76fa466ff0c7109',
  revokeSig:
    '07e7ae3a05fe56c43d3562a5c6334a1755301125b30c7cda3aa8e5987a2c039d' +
    'ff1338748bc0dcfdbcf9334528959071b5f3fda9d093913a531ae434898ed206',
  // Agent vouch + withdrawal for agent 0xd0..0xef, signed by the member root
  // as delegator (= operator root: the durable, words-issued vouch).
  vouchSig:
    '9a47c3d95c8a9865bbae1737f745626cdf807e61758da9ef1223dbec122b6a07' +
    '0800749a79eaa05abfae4fed6a105a90bd17b2d3cde75854cc67219586688808',
  vouchHash: '8a2f9e7ec96b0efb5f550ec83216782ba7581b780e847ee1f53bf35433926076',
  withdrawSig:
    'fd29aac8a81b84883fbf02eca651d9f8cb133440dabe368f78086c1575a3d12' +
    '07bc7a7853a8c74ee5041541eaf86aee1e19fb63bec8d3ad791f725ebd3eae60d',
  // Standalone device key for root seed 0x01..0x20, and the full handoff
  // bundle for that agent. Same construction as Go's handoffFixture.
  standaloneDevicePub: '584aecc36777bd7b3b3e7558623a001b284f9235cbf0bbbcbcad79efb9a53fce',
  handoffBundle:
    'cairn:agent:1:qGV2b3VjaFj7pmNzaWdYQM1bI6eAdK_wdM9RiKVKPqYeXPgrTWdT0CiyhawDERFsG_Sbw0PodBLuyLs35nJ5UJTnTToyz7jK7W5zoCvY4gBkdHlwZXBhZ2VudF9kZWxlZ2F0aW9uaWFnZW50X3B1YlggebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmRpaXNzdWVkX2F0GwAAAZB3_TAAbG9wZXJhdG9yX3B1YlggXHZyKoid7I1HNkCOtudBeHdQow9hyY_vXSmnIm4GG1FtZGVsZWdhdG9yX3B1YlggXHZyKoid7I1HNkCOtudBeHdQow9hyY_vXSmnIm4GG1FmaW52aXRlYGlyZWxheV9wdWJYIODh4uPk5ebn6Onq6-zt7u_w8fLz9PX29_j5-vv8_f7_aXJlbGF5X3VybHVodHRwOi8vMTI3LjAuMC4xOjgwOTlqYWdlbnRfbmFtZWZIZWxwZXJqYWdlbnRfc2VlZFggAQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyBrYXR0ZXN0YXRpb25Y6qdjc2lnWEDGqLuKoOG0mrHhHNpz7FDlxkMt05tflIFtqfmdAYkq0RFiWAZRVnxqT5RfayEzM7veTxNjUKFwvCDPr0cWVAYPZGtpbmRlYWdlbnRkdHlwZXRpZGVudGl0eV9hdHRlc3RhdGlvbmZwdWJrZXlYIHm1Vi6P5lT5QHixEuipi6eQH4U65pW-1-DjkQutBJZkaWlzc3VlZF9hdBsAAAGQd_0wAGtvcGVyYXRlZF9ieVggXHZyKoid7I1HNkCOtudBeHdQow9hyY_vXSmnIm4GG1FsZGlzcGxheV9uYW1lZkhlbHBlcnFkZXZpY2VfZGVsZWdhdGlvbljLpWNzaWdYQIkk6gNOgOaS8wFgl2rZonZdxv8hQY0xkZl8LtzUd1b78BI8aWCo0YtjzhWx-oln56pIQyAqOHXvIemVcSE6qwFkdHlwZXFkZXZpY2VfZGVsZWdhdGlvbmlpc3N1ZWRfYXQbAAABkHf9MABqZGV2aWNlX3B1YlggWErsw2d3vXs7PnVYYjoAGyhPkjXL8Lu8vK1577mlP85qcGFyZW50X3B1YlggebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ',
}

let failures = 0
function check(name: string, got: string, want: string) {
  if (got === want) {
    console.log(`  ok   ${name}`)
  } else {
    failures++
    console.error(`  FAIL ${name}\n         got  ${got}\n         want ${want}`)
  }
}
function assert(name: string, cond: boolean) {
  if (cond) console.log(`  ok   ${name}`)
  else {
    failures++
    console.error(`  FAIL ${name}`)
  }
}

console.log('identity conformance (browser vs Go golden vectors)')

// --- member root derivation ---
check('member root from mnemonic', hex(memberRootFromMnemonic(M, '').pub), GOLDEN.memberRootPub)

// --- self-attestation signing bytes ---
const member = memberRootFromMnemonic(M, '')
const att = newSelfAttestation(member, 'human', 'Sam', null, 1720000000000n)
check('attestation signature', hex(att.sig!), GOLDEN.attSig)
check('attestation content hash', hex(objectHash(att as unknown as Record<string, unknown>)), GOLDEN.attHash)
assert('attestation self-verifies', verifyAttestation(att))

// --- pairing wire format ---
const devicePub = new Uint8Array(32).map((_, i) => 0xa0 + i)
const req = newPairingRequest(devicePub, "Sam's phone")
check('pairing encoding', encodePairingRequest(req), GOLDEN.pairEncoded)
check('device fingerprint', fingerprint(devicePub), GOLDEN.fingerprint)
assert('pairing round trip', hex(parsePairingRequest(GOLDEN.pairEncoded).devicePub) === hex(devicePub))

// --- delegation & revoke signing bytes ---
//
// These are the objects a device signs to admit or retire ANOTHER device. Drift
// here means one side admits a device the other rejects. Signed by the member
// root as parent / revoker.
const parentKeys = memberRootFromMnemonic(M, '')
const dd = approvePairing(req, parentKeys.pub, parentKeys.priv, 1720000000000n)
check('device delegation signature', hex(dd.sig!), GOLDEN.delegationSig)
assert('delegation names its parent', hex(dd.parent_pub) === hex(parentKeys.pub))

const dr = revokeDevice(devicePub, parentKeys.pub, parentKeys.priv, 1720000000000n)
check('device revoke signature', hex(dr.sig!), GOLDEN.revokeSig)
assert('revoke names its revoker', hex(dr.revoker_pub) === hex(parentKeys.pub))

// --- agent vouch & withdrawal signing bytes ---
//
// These are the objects an operator's device signs to prove (or un-prove) an
// agent. Same construction as Go's TestConformance_VouchSigningBytes: agent
// 0xd0..0xef, delegator = operator root. Drift here means one side accepts a
// vouch the other rejects.
const agentPub = new Uint8Array(32).map((_, i) => 0xd0 + i)
const vouch = issueAgentVouch(agentPub, parentKeys.pub, parentKeys.priv, parentKeys.pub, 1720000000000n)
check('agent vouch signature', hex(vouch.sig!), GOLDEN.vouchSig)
check(
  'agent vouch content hash',
  hex(objectHash(vouch as unknown as Record<string, unknown>)),
  GOLDEN.vouchHash,
)
assert('vouch self-verifies', verifyAgentDelegation(vouch))
assert('vouch names its delegator', hex(vouch.delegator_pub) === hex(parentKeys.pub))
assert('vouch names its operator', hex(vouch.operator_pub) === hex(parentKeys.pub))

const wd = withdrawVouch(agentPub, parentKeys.pub, parentKeys.priv, 1720000100000n)
check('vouch withdrawal signature', hex(wd.sig!), GOLDEN.withdrawSig)
assert('withdrawal self-verifies', verifyVouchWithdraw(wd))

// --- standalone device derivation + handoff bundle ---
//
// The harness and the UI must derive the SAME device key from the agent seed,
// and speak the SAME bundle layout. Same construction as Go's handoffFixture:
// seed 0x01..0x20, operator = the phrase root, root-signed vouch.
const handoffSeed = new Uint8Array(32).map((_, i) => i + 1)
const handoffDevice = standaloneDeviceKey(handoffSeed)
check('standalone device pubkey', hex(handoffDevice.pub), GOLDEN.standaloneDevicePub)

const { encode: cborEncodeForBundle } = await import('../src/lib/cbor.ts')
const handoffRootPub = ed25519.getPublicKey(handoffSeed)
const handoffAtt = newSelfAttestation(
  { pub: handoffRootPub, priv: handoffSeed },
  'agent',
  'Helper',
  parentKeys.pub,
  1720000000000n,
)
const handoffDd = approvePairing(
  newPairingRequest(handoffDevice.pub, 'Helper'),
  handoffRootPub,
  handoffSeed,
  1720000000000n,
)
const handoffVouch = issueAgentVouch(
  handoffRootPub,
  parentKeys.pub,
  parentKeys.priv,
  parentKeys.pub,
  1720000000000n,
)
const handoffRelayPub = new Uint8Array(32).map((_, i) => 0xe0 + i)
const handoffBundle = encodeHandoffBundle({
  agent_seed: handoffSeed,
  relay_url: 'http://127.0.0.1:8099',
  relay_pub: handoffRelayPub,
  invite: '',
  attestation: cborEncodeForBundle(handoffAtt as unknown as Record<string, unknown>),
  device_delegation: cborEncodeForBundle(handoffDd as unknown as Record<string, unknown>),
  vouch: cborEncodeForBundle(handoffVouch as unknown as Record<string, unknown>),
  agent_name: 'Helper',
})
check('handoff bundle encoding', handoffBundle, GOLDEN.handoffBundle)
assert('handoff bundle round-trips through validation', (() => {
  try {
    const parsed = parseHandoffBundle(handoffBundle)
    return (
      hex(parsed.agent_seed) === hex(handoffSeed) &&
      hex(parsed.relay_pub) === hex(handoffRelayPub) &&
      parsed.agent_name === 'Helper'
    )
  } catch {
    return false
  }
})())

// A device cannot delegate or revoke ITSELF: self-delegation would be a cycle,
// and a revoke binds only from an ancestor.
assert(
  'self-delegation rejected',
  (() => {
    try {
      approvePairing(newPairingRequest(parentKeys.pub, 'self'), parentKeys.pub, parentKeys.priv, 1n)
      return false
    } catch {
      return true
    }
  })(),
)
assert(
  'self-revoke rejected',
  (() => {
    try {
      revokeDevice(parentKeys.pub, parentKeys.pub, parentKeys.priv, 1n)
      return false
    } catch {
      return true
    }
  })(),
)

// --- mnemonic handling ---
assert('valid mnemonic accepted', validateMnemonicPhrase(M) === null)
assert('short mnemonic rejected', validateMnemonicPhrase('abandon abandon') !== null)
assert('typo rejected', validateMnemonicPhrase(M.replace('art', 'zzzz')) !== null)
assert(
  'case/whitespace normalized',
  hex(memberRootFromMnemonic(`  ${M.toUpperCase().replace(/ /g, '  ')}  `).pub) === GOLDEN.memberRootPub,
)
assert('generated mnemonic is 24 words', newMnemonic().split(' ').length === 24)
assert('normalize is idempotent', normalizeMnemonic(normalizeMnemonic(M)) === normalizeMnemonic(M))

// --- rejections ---
for (const [name, bad] of Object.entries({
  'not a cairn code': 'https://example.com',
  'bad version': 'cairn:pair:99:AAAA:x',
  'short key': 'cairn:pair:1:AAAA:x',
})) {
  let threw = false
  try {
    parsePairingRequest(bad)
  } catch {
    threw = true
  }
  assert(`rejects ${name}`, threw)
}

// --- portable approval artifacts (must verify STANDALONE, outside Cairn) ---
// A grant leaves Cairn and is checked by a broker with no event envelope, so its
// signed type tag is what tells it from a deny. Golden values from Go.
const APPROVER_SEED = new Uint8Array(32).map((_, i) => i + 1)
const approverPub = ed25519.getPublicKey(APPROVER_SEED)
const signer = {
  pub: approverPub,
  sign: (m: Uint8Array) => ed25519.sign(m, APPROVER_SEED),
}
const fakeReq = {
  request_id: new TextEncoder().encode('request-0001'),
  agent_pub: new Uint8Array(32).map((_, i) => 0x30 + i),
  payload_type: 'cairn.capability.v1',
  payload: new TextEncoder().encode('x'),
  payload_hash: new Uint8Array(32).map((_, i) => 0x70 + i),
  issued_at: 0n,
  expires_at: 0n,
  sig: new Uint8Array(64),
} as unknown as Parameters<typeof signGrant>[0]

check(
  'approver pubkey',
  hex(approverPub),
  '79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664',
)

const g = signGrant(fakeReq, 1720000600000, signer)
// signGrant stamps issued_at from the clock; pin it to the golden value.
;(g as unknown as Record<string, unknown>).issued_at = 1720000000000
const gSig = signer.sign(
  (await import('../src/lib/cbor.ts')).encode({
    type: TYPE_GRANT,
    request_id: g.request_id,
    payload_hash: g.payload_hash,
    agent_pub: g.agent_pub,
    approver_pub: g.approver_pub,
    issued_at: 1720000000000n,
    expires_at: 1720000600000n,
    sig: null,
  }),
)
check(
  'approval GRANT signature',
  hex(gSig),
  '7dc0bc4625cc8a8394a24f7e0333ce4f59f8f0cf3fa2180f6fea09bac4ca1a39' +
    'd346bce1c77ce0c62ba20778e2fddeb86e92a5232c2275064fbeabc35f9d1909',
)

const dSig = signer.sign(
  (await import('../src/lib/cbor.ts')).encode({
    type: TYPE_DENY,
    request_id: fakeReq.request_id,
    approver_pub: approverPub,
    reason: 'not now',
    issued_at: 1720000000000n,
    sig: null,
  }),
)
check(
  'approval DENY signature',
  hex(dSig),
  'be9d9ee325a8d1192f62d4e21789ca790af8bba21b3d7ecc802ed1d7c01decf9' +
    'e25afd4bbc1f8880437f4daf1890de068243e8c95215f7a59e88f0f122994b0a',
)
assert('grant and deny signatures differ', hex(gSig) !== hex(dSig))
void signDeny

if (failures > 0) {
  console.error(`\n${failures} identity conformance failure(s) — browser and Go have DIVERGED.`)
  process.exit(1)
}
console.log('\nall identity conformance vectors match Go')
