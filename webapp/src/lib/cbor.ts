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
  /** Shortest IEEE-754 form that round-trips exactly (f16 → f32 → f64). */
  float(v: number) {
    const f16 = toF16(v)
    if (f16 !== null) {
      this.byte(0xf9)
      this.byte((f16 >> 8) & 0xff)
      this.byte(f16 & 0xff)
      return
    }
    const f32 = new DataView(new ArrayBuffer(4))
    f32.setFloat32(0, v)
    if (f32.getFloat32(0) === v || (Number.isNaN(v) && Number.isNaN(f32.getFloat32(0)))) {
      this.byte(0xfa)
      for (let i = 0; i < 4; i++) this.byte(f32.getUint8(i))
      return
    }
    const f64 = new DataView(new ArrayBuffer(8))
    f64.setFloat64(0, v)
    this.byte(0xfb)
    for (let i = 0; i < 8; i++) this.byte(f64.getUint8(i))
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
  } else if (typeof v === 'bigint') {
    if (v >= 0n) w.head(0, v)
    else w.head(1, -v - 1n) // negative int: major 1, value = -1-n
  } else if (typeof v === 'number') {
    if (Number.isInteger(v) && Number.isSafeInteger(v)) {
      const n = BigInt(v)
      if (n >= 0n) w.head(0, n)
      else w.head(1, -n - 1n)
    } else {
      // Non-integer (or out-of-safe-range): a real float, shortest form that
      // round-trips — matching Go's cbor.CoreDetEncOptions (ShortestFloat16).
      //
      // This used to be `BigInt(Math.trunc(v))`, which silently truncated every
      // fraction to an integer: poll shares, progress_fraction values and sensor
      // readings all became 0 on the wire. They rendered as zeros rather than
      // errors, so the corruption was invisible.
      //
      // LIMIT: JS cannot tell 640.0 from 640, so a whole number always encodes
      // as a CBOR int here while Go's float64(640) emits a float. Values
      // round-trip correctly either way; only the byte form differs. This is
      // safe because inlay bindings are never hashed — decl_cid covers the
      // DECLARATION, whose numbers are integers. Do not rely on byte-identical
      // encoding of whole-number floats across the two implementations.
      w.float(v)
    }
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

/** Encode as IEEE-754 half, or null if it does not round-trip exactly. */
function toF16(v: number): number | null {
  if (Number.isNaN(v)) return 0x7e00
  if (v === Infinity) return 0x7c00
  if (v === -Infinity) return 0xfc00
  if (v === 0) return Object.is(v, -0) ? 0x8000 : 0x0000

  const f32 = new DataView(new ArrayBuffer(4))
  f32.setFloat32(0, v)
  if (f32.getFloat32(0) !== v) return null // not even f32-exact
  const bits = f32.getUint32(0)

  const sign = (bits >>> 16) & 0x8000
  const exp = (bits >>> 23) & 0xff
  const mant = bits & 0x7fffff

  if (exp === 0xff) return null
  const unbiased = exp - 127
  if (unbiased < -14 || unbiased > 15) return null // out of half range
  if (mant & 0x1fff) return null // mantissa needs more than 10 bits
  return sign | ((unbiased + 15) << 10) | (mant >>> 13)
}

function f16ToNumber(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1
  const exp = (bits >>> 10) & 0x1f
  const mant = bits & 0x3ff
  if (exp === 0) return sign * mant * 2 ** -24
  if (exp === 0x1f) return mant ? NaN : sign * Infinity
  return sign * (mant + 1024) * 2 ** (exp - 25)
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
      // Floats. Go emits the shortest form that round-trips, so all three
      // widths appear on the wire and every one must decode — refusing them
      // made any Go-authored payload containing a fraction undecodable, so the
      // whole event silently failed to render.
      if (info === 25) return f16ToNumber((r.u8() << 8) | r.u8())
      if (info === 26) {
        const dv = new DataView(r.take(4).slice().buffer)
        return dv.getFloat32(0)
      }
      if (info === 27) {
        const dv = new DataView(r.take(8).slice().buffer)
        return dv.getFloat64(0)
      }
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
