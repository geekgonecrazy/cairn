<script lang="ts" module>
  // Icon path data ported from claude-design/cairn-icons.jsx. All icons share
  // viewBox 0 0 16 16, stroke=currentColor, width 1.5, round caps/joins. Filled
  // dots override with fill. Add more as components need them.
  export const ICONS: Record<string, string> = {
    hash: '<path d="M3 6h10M3 10h10M6 3l-1 10M11 3l-1 10"/>',
    lock: '<rect x="3.5" y="7" width="9" height="6" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 1 1 5 0v2"/>',
    users: '<circle cx="6" cy="6" r="2.2"/><path d="M2.5 13c.5-2 1.9-3 3.5-3s3 1 3.5 3"/><path d="M10.5 4.2a2.2 2.2 0 0 1 0 3.6M11 10c1.4.2 2.3 1.1 2.7 3"/>',
    person: '<circle cx="8" cy="5.5" r="2.4"/><path d="M3 13.5c.6-2.4 2.5-3.7 5-3.7s4.4 1.3 5 3.7"/>',
    house: '<path d="M2.5 7 8 3l5.5 4v6.5h-11V7Z"/><path d="M6.5 13.5v-3.5h3v3.5"/>',
    search: '<circle cx="7" cy="7" r="3.5"/><path d="m10 10 3 3"/>',
    plus: '<path d="M8 3v10M3 8h10"/>',
    back: '<path d="M10 3 5 8l5 5"/>',
    x: '<path d="M4 4l8 8M12 4l-8 8"/>',
    send: '<path d="M2.5 8 13 3l-3 10-2-4-5.5-1Z"/>',
    attach: '<path d="M11 5 6 10a1.8 1.8 0 0 0 2.5 2.5l5-5a3.2 3.2 0 0 0-4.5-4.5l-5 5a4.5 4.5 0 0 0 6.3 6.3l4.7-4.7"/>',
    smile: '<circle cx="8" cy="8" r="5.5"/><circle cx="6" cy="7" r=".5" fill="currentColor" stroke="none"/><circle cx="10" cy="7" r=".5" fill="currentColor" stroke="none"/><path d="M6 10c.6.7 1.3 1 2 1s1.4-.3 2-1"/>',
    smileplus: '<path d="M13.5 4.5h2M14.5 3.5v2"/><circle cx="7.5" cy="8.5" r="5"/><circle cx="5.5" cy="7.5" r=".5" fill="currentColor" stroke="none"/><circle cx="9.5" cy="7.5" r=".5" fill="currentColor" stroke="none"/><path d="M5.5 10.5c.6.7 1.3 1 2 1s1.4-.3 2-1"/>',
    settings: '<circle cx="8" cy="8" r="2"/><path d="M8 1.5v1.8M8 12.7v1.8M2.6 5l1.6.9M11.8 10.1l1.6.9M2.6 11l1.6-.9M11.8 5.9l1.6-.9M1.5 8h1.8M12.7 8h1.8"/>',
    reply: '<path d="M6 3 2 7l4 4"/><path d="M2 7h7a4 4 0 0 1 4 4v2"/>',
    check: '<path d="m3.5 8.5 3 3 6-6.5"/>',
    check2: '<path d="m3 8.5 2.5 2.5L10 6"/><path d="m7 11 1 1L13 7"/>',
    kebab: '<circle cx="8" cy="3.5" r=".9" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r=".9" fill="currentColor" stroke="none"/><circle cx="8" cy="12.5" r=".9" fill="currentColor" stroke="none"/>',
    spark: '<path d="M8 2v3M8 11v3M2 8h3M11 8h3M3.5 3.5l2 2M10.5 10.5l2 2M3.5 12.5l2-2M10.5 5.5l2-2"/>',
    bolt: '<path d="m9 2-5 7h3l-1 5 5-7H8l1-5Z"/>',
    mesh: '<circle cx="8" cy="3" r="1.5"/><circle cx="3.5" cy="12" r="1.5"/><circle cx="12.5" cy="12" r="1.5"/><path d="M8 4.5 4 10.5M8 4.5l4 6M5 12h6"/>',
    info: '<circle cx="8" cy="8" r="6"/><path d="M8 7.5v3.5M8 5.2v.1" stroke-width="1.6"/>',
    shield: '<path d="M8 2 3.5 4v4c0 3 2 5 4.5 6 2.5-1 4.5-3 4.5-6V4L8 2Z"/>',
    wifi: '<path d="M2 6.5a9 9 0 0 1 12 0M4.2 9a6 6 0 0 1 7.6 0M6.4 11.4a3 3 0 0 1 3.2 0"/><circle cx="8" cy="13" r=".6" fill="currentColor" stroke="none"/>',
    bell: '<path d="M4.5 7a3.5 3.5 0 0 1 7 0c0 3 1 4 1.5 4.5h-10C3.5 11 4.5 10 4.5 7Z"/><path d="M6.5 13a1.5 1.5 0 0 0 3 0"/>',
  }
</script>

<script lang="ts">
  let { name, size = 16 }: { name: string; size?: number } = $props()
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 16 16"
  fill="none"
  stroke="currentColor"
  stroke-width="1.5"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {@html ICONS[name] ?? ''}
</svg>
