<script lang="ts">
  import { onMount } from 'svelte'
  import Icon from '../Icon.svelte'
  import { app } from '../state.svelte'
  import { ui } from '../ui.svelte'
  import { roomStore } from '../rooms.svelte'
  import { directory } from '../directory.svelte'
  import { identity } from '../identity.svelte'
  import { fingerprint } from '../identity'
  import { hex } from '../api'

  // Settings always target the ACTIVE space (the one the sidebar is showing).
  const space = $derived(roomStore.spaces.find((s) => s.id === app.activeSpaceId))
  const channelCount = $derived(roomStore.inSpace(app.activeSpaceId).length)

  // Only the space OWNER may change anything — rename, membership, policy. Others
  // get a read-only view. (The carrier enforces this at the fold too; this just
  // avoids offering controls that would be silently ignored.)
  const isOwner = $derived(
    !!space && !!identity.current && space.owner === hex(identity.current.memberPub),
  )

  // Editable copies, seeded from the space's current state.
  let name = $state('')
  let allowAgents = $state(true)
  let origin = $state('own')

  let members = $state<{ pubHex: string; pub: Uint8Array; role: string; mine: boolean }[]>([])
  let peerKey = $state('')
  let busy = $state(false)
  let error = $state('')
  let saved = $state(false)

  onMount(() => {
    if (space) {
      name = space.name
      allowAgents = space.admitKind.includes('agent')
      origin = space.admitOrigin === 'own' ? 'own' : 'any'
    }
    void reloadMembers()
  })

  async function reloadMembers() {
    try {
      members = await app.spaceMembers()
    } catch {
      /* offline: leave whatever we had */
    }
  }

  async function save() {
    error = ''
    busy = true
    try {
      await app.updateSpace(name, allowAgents ? 'human,agent' : 'human', origin)
      saved = true
      setTimeout(() => (saved = false), 1400)
    } catch (e) {
      error = e instanceof Error ? e.message : 'could not save'
    } finally {
      busy = false
    }
  }

  async function addMember() {
    error = ''
    busy = true
    try {
      await app.addSpaceMemberByKey(peerKey)
      peerKey = ''
      await reloadMembers()
    } catch (e) {
      error = e instanceof Error ? e.message : 'could not add member'
    } finally {
      busy = false
    }
  }

  async function removeMember(pub: Uint8Array) {
    busy = true
    try {
      await app.removeSpaceMember(pub)
      await reloadMembers()
    } catch (e) {
      error = e instanceof Error ? e.message : 'could not remove member'
    } finally {
      busy = false
    }
  }
</script>

<div
  class="scrim"
  role="button"
  tabindex="0"
  onclick={(e) => e.target === e.currentTarget && ui.closeSpaceSettings()}
  onkeydown={(e) => e.key === 'Escape' && ui.closeSpaceSettings()}
>
  <div class="modal" role="dialog" aria-modal="true" aria-label="Space settings" tabindex="-1">
    <div class="m-head">
      <span class="ico"><Icon name="settings" size={16} /></span>
      <div class="titles">
        <h2>{space?.name ?? 'Space'} · Settings</h2>
        <div class="sub">{channelCount} channel{channelCount === 1 ? '' : 's'} · policy, not a fixed type</div>
      </div>
      <button class="x" aria-label="Close" onclick={() => ui.closeSpaceSettings()}><Icon name="x" /></button>
    </div>

    <div class="m-body">
      {#if !isOwner}
        <p class="hint note owner-note">
          <Icon name="info" size={12} /> Only the space's creator can change its members or settings.
          You're viewing this read-only.
        </p>
      {/if}

      <div class="field">
        <label for="space-rename">Space name</label>
        <input id="space-rename" bind:value={name} maxlength="40" spellcheck="false" disabled={!isOwner} />
      </div>

      <div class="field">
        <label for="roster">Members <span class="count">{members.length}</span></label>
        <ul id="roster" class="roster">
          {#each members as m (m.pubHex)}
            <li>
              <span class="who">
                {#if m.mine}
                  <strong>You</strong>
                {:else if directory.memberName(m.pubHex)}
                  <strong>{directory.memberName(m.pubHex)}</strong>
                {:else}
                  <span class="unresolved">cairn:{m.pubHex.slice(0, 6)}</span>
                {/if}
                {#if m.role === 'admin'}<span class="role">admin</span>{/if}
              </span>
              <span class="right">
                <code class="fpr">{fingerprint(m.pub)}</code>
                {#if isOwner && !m.mine}
                  <button class="rm" title="Remove from space" aria-label="Remove from space" disabled={busy} onclick={() => removeMember(m.pub)}>
                    <Icon name="x" size={13} />
                  </button>
                {/if}
              </span>
            </li>
          {:else}
            <li class="none">No members folded yet.</li>
          {/each}
        </ul>
        {#if isOwner}
          <div class="keyrow">
            <input placeholder="add a member by 64-hex member key" bind:value={peerKey} spellcheck="false" />
            <button class="btn sm primary" disabled={busy || !peerKey.trim()} onclick={addMember}>Add</button>
          </div>
        {/if}
        <p class="hint">
          The space roster is the umbrella: a channel member must be a space member. Removing someone
          here revokes their membership, and as channel members come online their channels drain them
          automatically (rotating keys). It can't take back messages they already hold.
        </p>
      </div>

      <div class="field">
        <span class="label-txt">Admit policy</span>
        <label class="toggle">
          <input type="checkbox" bind:checked={allowAgents} disabled={!isOwner} />
          <span>
            Allow agents in this space
            <small>When off, only <b>human</b>-kind identities may join its channels.</small>
          </span>
        </label>
        <div class="origins">
          <label class="rx" data-selected={origin === 'own'}>
            <input type="radio" name="origin" checked={origin === 'own'} disabled={!isOwner} onchange={() => (origin = 'own')} />
            <span><b>Own household only</b><small>The default — nobody outside your root of trust.</small></span>
          </label>
          <label class="rx" data-selected={origin === 'any'}>
            <input type="radio" name="origin" checked={origin === 'any'} disabled={!isOwner} onchange={() => (origin = 'any')} />
            <span><b>Any peer household</b><small>Anyone running the stack, after review.</small></span>
          </label>
        </div>
        <p class="hint note">
          <Icon name="info" size={12} /> Policy is recorded but not yet enforced — the carrier does not
          currently gate a join on it. Peer-household admission (specific roots) is a separate flow.
        </p>
      </div>

      {#if error}<p class="err" role="alert">{error}</p>{/if}
    </div>

    <div class="m-foot">
      <span class="grow"></span>
      <button class="btn" onclick={() => ui.closeSpaceSettings()}>Close</button>
      <button class="btn primary" disabled={!isOwner || busy || name.trim().length < 2} onclick={save}>
        {saved ? 'Saved' : 'Save settings'}
      </button>
    </div>
  </div>
</div>

<style>
  .roster {
    list-style: none;
    margin: 6px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .roster li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--r-2, 8px);
    font-size: 13px;
  }
  .roster li.none { border-style: dashed; color: var(--text-3); font-size: 12px; }
  .who { display: flex; align-items: center; gap: 7px; min-width: 0; }
  .right { display: flex; align-items: center; gap: 8px; }
  .unresolved { font-family: var(--font-mono, monospace); color: var(--text-3); }
  .role {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 2px 6px;
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--text-3);
  }
  .fpr { font-family: var(--font-mono, monospace); font-size: 11px; color: var(--text-3); }
  .rm {
    width: 24px;
    height: 24px;
    display: grid;
    place-items: center;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-3);
    border-radius: 6px;
    cursor: pointer;
  }
  .rm:hover:not(:disabled) { color: var(--neg, #dc2626); border-color: var(--neg, #dc2626); }
  .rm:disabled { opacity: 0.5; cursor: default; }
  .count { font-family: var(--font-mono, monospace); color: var(--text-3); }

  .toggle { display: flex; gap: 9px; align-items: flex-start; cursor: pointer; font-size: 13px; }
  .toggle input { margin-top: 2px; width: 16px; height: 16px; flex: 0 0 auto; accent-color: var(--accent, #2563eb); }
  .toggle small, .rx small { display: block; margin-top: 2px; font-size: 11.5px; line-height: 1.5; color: var(--text-3); }
  .origins { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }
  .rx {
    display: flex;
    gap: 9px;
    align-items: flex-start;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--r-2, 8px);
    cursor: pointer;
    font-size: 13px;
  }
  .rx[data-selected='true'] { border-color: var(--accent); background: var(--accent-soft, transparent); }
  .rx input { margin-top: 2px; accent-color: var(--accent, #2563eb); }
  .label-txt { font-size: 12px; font-weight: 500; color: var(--text-2); }
  .note { display: flex; gap: 6px; align-items: flex-start; }

  .scrim {
    position: fixed;
    inset: 0;
    background: color-mix(in oklab, oklch(0.05 0.01 260) 50%, transparent);
    backdrop-filter: blur(2px);
    z-index: 50;
    display: grid;
    place-items: center;
    padding: 24px;
  }
  .modal {
    width: min(500px, 100%);
    max-height: calc(100dvh - 48px);
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-4);
    box-shadow: var(--shadow-3);
    overflow: hidden;
    cursor: default;
  }
  .m-head { display: flex; align-items: center; gap: 10px; padding: 16px 18px 12px; }
  .m-head .ico { color: var(--text-3); display: grid; place-items: center; }
  .titles { min-width: 0; }
  .m-head h2 { margin: 0; font-size: 15px; font-weight: 600; }
  .m-head .sub { font-size: 11.5px; color: var(--text-3); margin-top: 2px; }
  .m-head .x {
    margin-left: auto;
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    border: none;
    background: transparent;
    color: var(--text-3);
    border-radius: var(--r-1);
    cursor: pointer;
  }
  .m-head .x:hover { background: var(--surface-2); color: var(--text); }
  .m-body { padding: 4px 18px 8px; display: flex; flex-direction: column; gap: 16px; overflow-y: auto; }
  .field { display: flex; flex-direction: column; gap: 6px; }
  .field > label, .field label[for] { font-size: 12px; font-weight: 500; color: var(--text-2); }
  .field input:not([type]), .keyrow input, #space-rename {
    font: inherit;
    font-size: 14px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--r-2);
    padding: 9px 11px;
    color: var(--text);
    outline: none;
  }
  #space-rename:focus, .keyrow input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .keyrow { display: flex; gap: 8px; align-items: center; margin-top: 4px; }
  .keyrow input { flex: 1; font-family: var(--font-mono); font-size: 12px; }
  .hint { margin: 0; font-size: 11.5px; color: var(--text-3); line-height: 1.5; }
  .err { margin: 0; font-size: 12px; color: var(--neg, #dc2626); }
  .m-foot { display: flex; align-items: center; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--border); }
  .grow { flex: 1; }
  .btn {
    height: 32px;
    padding: 0 14px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border-radius: var(--r-2);
    font-size: 12.5px;
    font-weight: 600;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
  }
  .btn:hover:not(:disabled) { background: var(--surface-2); }
  .btn.primary { background: var(--accent); color: var(--accent-fg, #fff); border-color: var(--accent); }
  .btn.primary:hover:not(:disabled) { filter: brightness(1.05); }
  .btn.sm { height: 30px; padding: 0 11px; font-size: 12px; }
  .btn:disabled { opacity: 0.55; cursor: not-allowed; }
</style>
