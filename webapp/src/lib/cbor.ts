// Minimal deterministic CBOR (RFC 8949 §4.2 core deterministic) — encode +
// decode, hand-written so the event content tuple hashes byte-identically to
// Go's fxamacker CoreDetEncOptions. Supports exactly what Cairn needs: unsigned
// & negative integers (shortest form), byte strings, text strings, arrays,
// string-keyed maps (keys sorted by encoded-key bytes), bool, null.
//
// The signed event content is an array of scalars/byte-strings, so its encoding
// is unambiguous and matches Go regardless. Map key sorting matters only for
// payload plaintext (each side decodes the other's), but we sort anyway.

export type CborValue =
  | Uint8Array
  | string
  | number
  | bigint
  | boolean
  | null
  | CborValue[]
  | { [k: string]: CborValue }

// ---- encode ----

class Writer {
  private chunks: number[] = []
  byte(b: number) {
    this.chunks.push(b & 0xff)
  }
  bytes(b: Uint8Array) {
    for (let i = 0; i < b.length; i++) this.chunks.push(b[i])
  }
  head(major: number, n: bigint) {
    const m = major << 5
    if (n < 24n) this.byte(m | Number(n))
    else if (n < 0x100n) {
      this.byte(m | 24)
      this.byte(Number(n))
    } else if (n < 0x10000n) {
      this.byte(m | 25)
      this.u(n, 2)
    } else if (n < 0x100000000n) {
      this.byte(m | 26)
      this.u(n, 4)
    } else {
      this.byte(m | 27)
      this.u(n, 8)
    }
  }
  private u(n: bigint, bytes: number) {
    for (let i = bytes - 1; i >= 0; i--) this.byte(Number((n >> BigInt(i * 8)) & 0xffn))
  }
  out(): Uint8Array {
    return new Uint8Array(this.chunks)
  }
}

function encodeInto(w: Writer, v: CborValue) {
  if (v === null) {
    w.byte(0xf6)
  } else if (typeof v === 'boolean') {
    w.byte(v ? 0xf5 : 0xf4)
  } else if (typeof v === 'number' || typeof v === 'bigint') {
    let n = typeof v === 'bigint' ? v : BigInt(Math.trunc(v))
    if (n >= 0n) w.head(0, n)
    else w.head(1, -n - 1n) // negative int: major 1, value = -1-n
  } else if (v instanceof Uint8Array) {
    w.head(2, BigInt(v.length))
    w.bytes(v)
  } else if (typeof v === 'string') {
    const b = new TextEncoder().encode(v)
    w.head(3, BigInt(b.length))
    w.bytes(b)
  } else if (Array.isArray(v)) {
    w.head(4, BigInt(v.length))
    for (const el of v) encodeInto(w, el)
  } else {
    // string-keyed map, keys sorted by their encoded bytes (core det order)
    const entries = Object.entries(v).filter(([, val]) => val !== undefined)
    const encoded = entries.map(([k, val]) => {
      const kw = new Writer()
      encodeInto(kw, k)
      return { key: kw.out(), val }
    })
    encoded.sort((a, b) => cmpBytes(a.key, b.key))
    w.head(5, BigInt(encoded.length))
    for (const e of encoded) {
      w.bytes(e.key)
      encodeInto(w, e.val)
    }
  }
}

export function encode(v: CborValue): Uint8Array {
  const w = new Writer()
  encodeInto(w, v)
  return w.out()
}

function cmpBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return a.length - b.length
}

// ---- decode ----

class Reader {
  constructor(
    private buf: Uint8Array,
    public pos = 0,
  ) {}
  u8(): number {
    return this.buf[this.pos++]
  }
  take(n: number): Uint8Array {
    const s = this.buf.subarray(this.pos, this.pos + n)
    this.pos += n
    return s
  }
  uint(info: number): bigint {
    if (info < 24) return BigInt(info)
    let bytes = 0
    if (info === 24) bytes = 1
    else if (info === 25) bytes = 2
    else if (info === 26) bytes = 4
    else if (info === 27) bytes = 8
    else throw new Error('cbor: bad length info ' + info)
    let n = 0n
    for (let i = 0; i < bytes; i++) n = (n << 8n) | BigInt(this.u8())
    return n
  }
}

function decodeFrom(r: Reader): CborValue {
  const ib = r.u8()
  const major = ib >> 5
  const info = ib & 0x1f
  switch (major) {
    case 0:
      return numberize(r.uint(info))
    case 1:
      return numberize(-1n - r.uint(info))
    case 2:
      return r.take(Number(r.uint(info)))
    case 3:
      return new TextDecoder().decode(r.take(Number(r.uint(info))))
    case 4: {
      const len = Number(r.uint(info))
      const arr: CborValue[] = []
      for (let i = 0; i < len; i++) arr.push(decodeFrom(r))
      return arr
    }
    case 5: {
      const len = Number(r.uint(info))
      const obj: { [k: string]: CborValue } = {}
      for (let i = 0; i < len; i++) {
        const k = decodeFrom(r)
        obj[String(k)] = decodeFrom(r)
      }
      return obj
    }
    case 7:
      if (info === 20) return false
      if (info === 21) return true
      if (info === 22) return null
      throw new Error('cbor: unsupported simple/float ' + info)
    default:
      throw new Error('cbor: unsupported major ' + major)
  }
}

// Keep ints that fit in a JS number as number, else bigint.
function numberize(n: bigint): number | bigint {
  return n >= -9007199254740991n && n <= 9007199254740991n ? Number(n) : n
}

export function decode(buf: Uint8Array): CborValue {
  return decodeFrom(new Reader(buf))
}
