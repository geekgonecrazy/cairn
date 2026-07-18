<script lang="ts" module>
  // Shared helpers for the role primitives. Polarity is the renderer's ONLY
  // colour decision — a declaration never names a colour.
  import type { Polarity } from './types'

  export function relTime(ms: number): string {
    const mins = Math.max(0, Math.round((Date.now() - ms) / 60000))
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    const h = Math.round(mins / 60)
    if (h < 24) return `${h}h ago`
    return `${Math.round(h / 24)}d ago`
  }

  export function polarityOf(v: unknown, fallback: Polarity = 'neutral'): Polarity {
    const s = String(v ?? '')
    return s === 'positive' || s === 'negative' || s === 'busy' || s === 'neutral' ? s : fallback
  }

  /** Sparkline geometry per the design reference: 3px vertical inset, area fill
   *  under the line, dot on the last sample. */
  export function sparkPath(data: number[], width: number, height: number) {
    if (data.length < 2) return null
    const min = Math.min(...data)
    const max = Math.max(...data)
    const span = max - min || 1
    const stepX = width / (data.length - 1)
    const y = (v: number) => height - 3 - ((v - min) / span) * (height - 6)
    const pts = data.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * stepX).toFixed(2)} ${y(v).toFixed(2)}`)
    const line = pts.join(' ')
    return {
      line,
      area: `${line} L ${width} ${height} L 0 ${height} Z`,
      lastX: (data.length - 1) * stepX,
      lastY: y(data[data.length - 1]),
      bandRect: (lo: number, hi: number) => ({
        y: y(Math.min(hi, max)),
        h: Math.max(0, y(Math.max(lo, min)) - y(Math.min(hi, max))),
      }),
    }
  }
</script>
