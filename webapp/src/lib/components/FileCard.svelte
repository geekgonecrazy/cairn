<script lang="ts">
  // A file on chat. The envelope arrived; the bytes may not have. Every state
  // here is real — no fake "available", no endless spinner. "pending — no fat
  // link" is a legitimate resting state, not a failure.
  import Icon from '../Icon.svelte'
  import { app, type Msg } from '../state.svelte'
  import { openFile, probeFile, humanSize, refHex, type RetrievalState } from '../files'
  import { roomKeyBytes } from '../crypto'

  let { msg }: { msg: Msg } = $props()
  const f = $derived(msg.file!)

  let retrieval = $state<RetrievalState>('pending')
  let objectUrl = $state<string | null>(null)
  let probed = $state(false)

  const isImage = $derived(f.ref.mime.startsWith('image/'))

  // Probe availability once, without pulling the whole object.
  $effect(() => {
    if (probed) return
    probed = true
    void probeFile(f.ref).then((s) => (retrieval = s))
  })

  $effect(() => () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl)
  })

  async function download() {
    retrieval = 'downloading'
    try {
      const bytes = await openFile(roomKeyBytes(app.currentRoomId), f.ref)
      const blob = new Blob([bytes as unknown as BlobPart], { type: f.ref.mime })
      objectUrl = URL.createObjectURL(blob)
      retrieval = 'available'
      if (!isImage) {
        const a = document.createElement('a')
        a.href = objectUrl
        a.download = f.ref.name ?? 'file'
        a.click()
      }
    } catch (e) {
      retrieval = e instanceof Error && e.message === 'broken' ? 'broken' : 'pending'
    }
  }

  const stateLabel = $derived(
    retrieval === 'available' ? 'available' :
    retrieval === 'downloading' ? 'downloading…' :
    retrieval === 'broken' ? 'broken — failed verification' :
    'pending — no fat link',
  )
  const polarity = $derived(
    retrieval === 'available' ? 'positive' : retrieval === 'broken' ? 'negative' : 'busy',
  )
</script>

<div class="msg-file">
  <div class="file-card" data-state={retrieval}>
    <div class="thumb" class:img={isImage}>
      {#if objectUrl && isImage}
        <img src={objectUrl} alt={f.ref.name ?? 'image'} />
      {:else}
        <Icon name={isImage ? 'image' : 'file'} size={18} />
      {/if}
    </div>

    <div class="body">
      <div class="name">{f.ref.name ?? 'file'}</div>
      <div class="meta">
        {humanSize(f.ref.size)} · {f.ref.mime}
        <span class="hash" title={refHex(f.ref.hash)}>· {refHex(f.ref.hash).slice(0, 8)}</span>
      </div>
      <div class="foot">
        <span class="status-chip" data-polarity={polarity}><span class="swatch"></span>{stateLabel}</span>
        {#if retrieval !== 'downloading'}
          <button class="btn sm" onclick={download}>
            {retrieval === 'available' && objectUrl ? 'Save' : retrieval === 'broken' ? 'Retry' : 'Fetch'}
          </button>
        {/if}
      </div>
    </div>
  </div>
  {#if f.caption}<div class="caption">{f.caption}</div>{/if}
</div>

<style>
  .msg-file { padding: 4px 24px 6px; }
  .file-card {
    display: grid;
    grid-template-columns: 56px 1fr;
    gap: 12px;
    align-items: center;
    max-width: 460px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: var(--r-3);
    background: var(--surface);
    box-shadow: var(--shadow-1);
  }
  .file-card[data-state='broken'] { border-color: color-mix(in oklab, var(--neg) 40%, var(--border)); }
  .file-card[data-state='pending'] { border-style: dashed; }

  .thumb {
    width: 56px; height: 56px; border-radius: var(--r-2);
    display: grid; place-items: center; overflow: hidden;
    background: var(--surface-2); color: var(--text-3);
    border: 1px solid var(--border);
  }
  .thumb img { width: 100%; height: 100%; object-fit: cover; }

  .body { min-width: 0; }
  .name {
    font-size: 13.5px; font-weight: 600; color: var(--text);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .meta { font: 500 11px/1.4 var(--font-mono); color: var(--text-3); margin-top: 2px; }
  .hash { color: var(--text-4); }
  .foot { display: flex; align-items: center; gap: 8px; margin-top: 8px; }

  .status-chip {
    display: inline-flex; align-items: center; gap: 6px;
    font: 500 10.5px/1 var(--font-mono); text-transform: lowercase; letter-spacing: 0.04em;
    padding: 3px 7px 3px 6px; border-radius: var(--r-1);
    border: 1px solid var(--border-2); background: var(--surface-2); color: var(--text-2);
  }
  .status-chip .swatch { width: 6px; height: 6px; border-radius: 50%; background: var(--text-3); }
  .status-chip[data-polarity='positive'] {
    color: var(--pos); background: var(--pos-soft);
    border-color: color-mix(in oklab, var(--pos) 35%, var(--border));
  }
  .status-chip[data-polarity='positive'] .swatch { background: var(--pos); }
  .status-chip[data-polarity='negative'] {
    color: var(--neg); background: var(--neg-soft);
    border-color: color-mix(in oklab, var(--neg) 40%, var(--border));
  }
  .status-chip[data-polarity='negative'] .swatch { background: var(--neg); }
  .status-chip[data-polarity='busy'] {
    color: var(--busy); background: var(--busy-soft);
    border-color: color-mix(in oklab, var(--busy) 40%, var(--border));
  }
  .status-chip[data-polarity='busy'] .swatch { background: var(--busy); }

  .btn {
    height: 26px; padding: 0 10px; border-radius: var(--r-2);
    font-size: 12px; font-weight: 600; border: 1px solid var(--border);
    background: var(--surface); color: var(--text); cursor: pointer;
    margin-left: auto;
  }
  .btn:hover { background: var(--surface-2); border-color: var(--border-2); }
  .caption { margin: 6px 0 0 2px; font-size: 13.5px; color: var(--text); max-width: 460px; }
</style>
