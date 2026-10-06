<script lang="ts">
  // Agents surface: mint an agent you own, vouch for it from this device, and
  // hand it a show-once handoff bundle its harness bootstraps from.
  //
  // PUBLIC material only is kept (see vault.myAgents): the agent's private key
  // leaves in the bundle and is never persisted here. Vouching, re-vouching
  // and withdrawing all sign with YOUR device key, so none of this needs your
  // 24 words.
  import QRCode from 'qrcode'
  import { identity } from '../identity.svelte'
  import { directory } from '../directory.svelte'
  import { cairn, hex } from '../api'
  import {
    mintAgent,
    rememberAgent,
    forgetAgent,
    myAgents,
    withdrawAgentVouch,
    fingerprint,
    type MyAgent,
  } from '../vault'
  import { encodeHandoffBundle, fingerprint as fp } from '../identity'
  import { encode as cborEncode, type CborValue } from '../cbor'

  let id = $derived(identity.current)

  async function copy(s: string) {
    try {
      await navigator.clipboard.writeText(s)
    } catch {
      /* clipboard blocked; text is on screen */
    }
  }

  // --- creation ---------------------------------------------------------

  let agentName = $state('')
  let creating = $state(false)
  let createError = $state('')
  // The show-once bundle. Held in memory only — dismissing this panel forgets
  // the agent's private key on purpose. The bundle IS the recovery: the same
  // seed re-derives everything, so tell the human to store it somewhere safe.
  let bundle = $state<string | null>(null)
  let bundleQr = $state('')
  let bundleFp = $state('')
  let bundleName = $state('')
  let agents = $state<MyAgent[]>(myAgents())
  let requireInvite = $state(false)

  async function create() {
    if (!id || creating) return
    creating = true
    createError = ''
    try {
      const now = BigInt(Date.now())
      const minted = mintAgent(id, agentName, now)
      // Publish attestation + first-device delegation + our vouch. If any
      // fails the agent is half-born — say so, loudly, rather than showing a
      // bundle for an agent nobody can resolve.
      const pubs: [string, Record<string, unknown>][] = [
        ['attestation', minted.attestation as unknown as Record<string, unknown>],
        ['device delegation', minted.delegation as unknown as Record<string, unknown>],
        ['vouch', minted.vouch as unknown as Record<string, unknown>],
      ]
      for (const [what, obj] of pubs) {
        if (!(await identity.publishObject(obj))) {
          throw new Error(`could not publish the agent's ${what} — is the relay reachable?`)
        }
      }
      let relayPub: Uint8Array = new Uint8Array(32)
      try {
        const info = await cairn.relayInfo({})
        relayPub = info.relayPub
        requireInvite = info.requireInvite
      } catch {
        throw new Error('could not read relay info — is the relay reachable?')
      }
      const b = encodeHandoffBundle({
        agent_seed: minted.seed,
        relay_url: window.location.origin,
        relay_pub: relayPub,
        invite: '',
        attestation: cborEncode(minted.attestation as unknown as CborValue),
        device_delegation: cborEncode(minted.delegation as unknown as CborValue),
        vouch: cborEncode(minted.vouch as unknown as CborValue),
        agent_name: agentName.trim(),
      })
      rememberAgent({
        name: agentName.trim(),
        agentPub: minted.agentPub,
        devicePub: minted.devicePub,
        vouch: minted.vouch,
      })
      agents = myAgents()
      bundle = b
      bundleName = agentName.trim()
      bundleFp = fp(minted.agentPub)
      bundleQr = await QRCode.toDataURL(b, { width: 220, margin: 1 })
      agentName = ''
    } catch (e) {
      createError = e instanceof Error ? e.message : String(e)
    } finally {
      creating = false
    }
  }

  function dismissBundle() {
    // Forgetting on purpose: the seed was shown once and must not linger.
    bundle = null
    bundleQr = ''
  }

  // --- my agents ----------------------------------------------------------

  let status = $state<Record<string, string>>({})
  let withdrawing = $state('')
  let withdrawError = $state('')

  async function checkStatus(a: MyAgent) {
    const k = hex(a.agentPub)
    status[k] = 'checking…'
    try {
      const t = await directory.resolveAwait(a.devicePub)
      status[k] =
        t.state === 'verified' && t.kind === 'agent'
          ? t.agentProven
            ? 'proven — your vouch holds'
            : 'UNPROVEN — no live vouch (withdrawn? expired?)'
          : `unexpected: ${t.state}`
    } catch {
      status[k] = 'could not resolve (offline?)'
    }
    status = { ...status }
  }

  async function withdraw(a: MyAgent) {
    if (!id || withdrawing) return
    withdrawing = hex(a.agentPub)
    withdrawError = ''
    try {
      const w = withdrawAgentVouch(id, a, BigInt(Date.now()))
      if (!(await identity.publishObject(w as unknown as Record<string, unknown>))) {
        throw new Error('could not publish the withdrawal — the relay may not know the agent is dead.')
      }
      agents = myAgents()
      delete status[hex(a.agentPub)]
      status = { ...status }
    } catch (e) {
      withdrawError = e instanceof Error ? e.message : String(e)
    } finally {
      withdrawing = ''
    }
  }

  function drop(a: MyAgent) {
    // Local bookkeeping only: the vouch lives on the relay until withdrawn.
    // Withdrawing first is what actually un-proves the agent.
    forgetAgent(a.agentPub)
    agents = myAgents()
  }
</script>

{#if !id}
  <p class="muted">No identity on this device.</p>
{:else}
  <section>
    <h3>New agent</h3>
    <p class="muted">
      Mint an agent that belongs to you: its own member key and name, with your
      vouch signed by this device — no recovery words. You hand it a bundle its
      harness bootstraps from.
    </p>
    {#if bundle}
      <div class="bundle" role="status">
        <p>
          <strong>{bundleName}</strong> is born and vouched. This bundle holds its
          <strong>only copy of the agent's key</strong> — copy it into the harness
          now. Dismissing forgets it on purpose; it is also the recovery, so store
          it somewhere safe.
        </p>
        {#if bundleQr}<img src={bundleQr} alt="agent handoff bundle QR" width="220" height="220" />{/if}
        <code class="keyval">{bundle}</code>
        <div class="row">
          <button class="copy" onclick={() => copy(bundle ?? '')}>Copy bundle</button>
          <button onclick={dismissBundle}>I've saved it — forget</button>
        </div>
        <div class="fp">agent fingerprint {bundleFp} — confirm it matches in the harness</div>
      </div>
    {:else}
      <div class="row">
        <input
          placeholder="Agent name (e.g. Sous-chef)"
          bind:value={agentName}
          maxlength={60}
          aria-label="Agent name"
        />
        <button onclick={create} disabled={creating || !agentName.trim()}>
          {creating ? 'Creating…' : 'Create agent'}
        </button>
      </div>
      {#if createError}<p class="error" role="alert">{createError}</p>{/if}
    {/if}
  </section>

  <section>
    <h3>My agents{agents.length ? ` (${agents.length})` : ''}</h3>
    {#if agents.length === 0}
      <p class="muted">None yet. Agents you create here are listed with their vouch status.</p>
    {:else}
      <ul class="agents">
        {#each agents as a (hex(a.agentPub))}
          <li>
            <div>
              <strong>{a.name}</strong>
              {#if a.withdrawnAt}<span class="tag danger">withdrawn</span>{/if}
              <div class="fp mono">{hex(a.agentPub)}</div>
              <div class="fp">fingerprint {fingerprint(a.agentPub)}</div>
              {#if status[hex(a.agentPub)]}<div class="small">{status[hex(a.agentPub)]}</div>{/if}
              {#if requireInvite}
                <div class="small muted">
                  This relay is invite-only and the agent needs its own admission:
                  run <code>cairnctl allow {hex(a.agentPub)}</code> on the relay.
                </div>
              {/if}
            </div>
            <div class="row">
              <button class="copy" onclick={() => copy(hex(a.agentPub))}>Copy key</button>
              <button onclick={() => checkStatus(a)}>Check status</button>
              {#if !a.withdrawnAt}
                <button
                  class="danger"
                  disabled={withdrawing === hex(a.agentPub)}
                  onclick={() => withdraw(a)}
                >
                  {withdrawing === hex(a.agentPub) ? 'Withdrawing…' : 'Withdraw vouch'}
                </button>
              {/if}
              <button class="quiet" onclick={() => drop(a)} title="Remove from this list only — the vouch stays on the relay until withdrawn">
                Forget
              </button>
            </div>
          </li>
        {/each}
      </ul>
      {#if withdrawError}<p class="error" role="alert">{withdrawError}</p>{/if}
    {/if}
  </section>
{/if}

<style>
  section {
    margin-bottom: 18px;
  }
  h3 {
    margin: 0 0 6px;
  }
  .row {
    display: flex;
    gap: 8px;
    margin-top: 8px;
    flex-wrap: wrap;
  }
  input {
    flex: 1;
    min-width: 180px;
  }
  .bundle {
    border: 1px solid var(--warn, #a60);
    border-radius: 8px;
    padding: 12px;
  }
  .bundle code {
    display: block;
    overflow-wrap: anywhere;
    margin: 8px 0;
  }
  .agents {
    list-style: none;
    padding: 0;
    margin: 8px 0 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .agents li {
    border: 1px solid var(--line, #333);
    border-radius: 8px;
    padding: 10px;
  }
  .mono {
    font-family: monospace;
    font-size: 11px;
    overflow-wrap: anywhere;
  }
</style>
