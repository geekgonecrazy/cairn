// Identity-conformance check: the browser's household derivation, attestation
// signing bytes, and pairing encoding must match Go's `identity` package
// EXACTLY. Golden values below were produced by Go (identity/conformance_test.go
// asserts the same constants).
//
// Any drift means a household bootstrapped in a browser derives a different
// root, or signs over different bytes, and its events fail chain-walk
// verification server-side. Release-blocking.
//
// Run: `npm run identity-conformance`.

import {
  householdRootFromMnemonic,
  provisionMember,
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
  memberRootFromMnemonic,
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
  rootPub: '32320b447bf42226bac93895f0fae6e17b7e01c71114afb875bbcc3018d9f2fb',
  rootPubPass: '3ad8f11fdced46794845eb00de0dc716012cf1cda63340445ca869a5d20fca7f',
  attSig:
    '8f1e097a73031890084a894c01fe74bf6edf210ba9c5b5716419b6d0c409621a' +
    '49c4cba9e71c9cb49a4b8e5d8ac5af664990c0f0f4083d9757d9941b3f3ac707',
  attHash: '3881da6f4d41eafce59092690a44dcf2af64bdabeb0f5bbd6785ffe80ea7955c',
  pairEncoded: "cairn:pair:1:oKGio6SlpqeoqaqrrK2ur7CxsrO0tba3uLm6u7y9vr8:Sam's phone",
  fingerprint: 'a0a1-a2a3-a4a5-a6a7',
  memberRootPub: '5c76722a889dec8d4736408eb6e741787750a30f61c98fef5d29a7226e061b51',
  delegationSig:
    '31c61e17088c202fe7a594f2e418a7c5e1108cd746684d5a164e13afdecc3e46' +
    'ea8d26a2fa48f4bc0520c5baf158de3194393d4cca88c1b89f524ee1745c8408',
  revokeSig:
    '94fdd5259a246a127ff63e7944a6bb754296aca3bf1fcc2caa8b1622ca11c89d' +
    'c2e04d8f7b955442cbc29765681a69f409695d50802470bbe6bd9ead005f3606',
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

// --- household derivation ---
check('household root from mnemonic', hex(householdRootFromMnemonic(M, '').pub), GOLDEN.rootPub)
check('household root with passphrase', hex(householdRootFromMnemonic(M, 'trezor').pub), GOLDEN.rootPubPass)

// --- member root derivation ---
// Same words as the household above; the HKDF label is the only difference, and
// it MUST produce a different key — otherwise a member could sign attestations
// as their own household.
check('member root from mnemonic', hex(memberRootFromMnemonic(M, '').pub), GOLDEN.memberRootPub)
assert(
  'member root differs from household root',
  hex(memberRootFromMnemonic(M, '').pub) !== hex(householdRootFromMnemonic(M, '').pub),
)

// --- attestation signing bytes ---
const memberPub = new Uint8Array(32).map((_, i) => i)
const att = provisionMember(M, '', memberPub, 'human', 'Sam', null, 1720000000000n)
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
// here means one side admits a device the other rejects — and it went unpinned
// until the delegation tree landed, which is how member_pub could be renamed to
// parent_pub / revoker_pub with every suite still green.
const parentKeys = householdRootFromMnemonic(M, '')
const dd = approvePairing(req, parentKeys.pub, parentKeys.priv, 1720000000000n)
check('device delegation signature', hex(dd.sig!), GOLDEN.delegationSig)
assert('delegation names its parent', hex(dd.parent_pub) === hex(parentKeys.pub))

const dr = revokeDevice(devicePub, parentKeys.pub, parentKeys.priv, 1720000000000n)
check('device revoke signature', hex(dr.sig!), GOLDEN.revokeSig)
assert('revoke names its revoker', hex(dr.revoker_pub) === hex(parentKeys.pub))

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
  hex(householdRootFromMnemonic(`  ${M.toUpperCase().replace(/ /g, '  ')}  `).pub) === GOLDEN.rootPub,
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
// A grant leaves Cairn and is checked by a broker with no event envelope, so
// its signed type tag is what tells it from a deny. Golden values from Go
// (scratch generator mirroring approval.Sign).
const APPROVER_SEED = new Uint8Array(32).map((_, i) => i + 1)
const approverPub = ed25519.getPublicKey(APPROVER_SEED)
const signer = {
  pub: approverPub,
  sign: (m: Uint8Array) => ed25519.sign(m, APPROVER_SEED),
}
const fakeReq = {
  request_id: new TextEncoder().encode('request-0001'),
  agent_pub: new Uint8Array(32).map((_, i) => 0x30 + i),
  request_hash: new Uint8Array(32).map((_, i) => 0x70 + i),
  capability: { name: 'x' },
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
    capability_hash: g.capability_hash,
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
  '4192e8498bfc7b96ec92ea054b5446cef0683ad27e6461d3bd6c6a3a16f3ae79' +
    '7c0cc86e6e9a7edef3144b7eaa8596ed8d99e2201622d5b6405e951a51e02806',
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
