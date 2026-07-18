// Sample instances for posting inlays from the composer (`/inlay <name>`).
// These are ordinary bindings — nothing here is special-cased by the renderer.
// The greenhouse one is the proof of the Phase 2 exit criterion: a declaration
// that is NOT in the standard library, rendering purely from primitives, and
// degrading to its text line.

import { CID } from './registry'
import type { InlayInstance } from './types'

export const SAMPLES: Record<string, InlayInstance> = {
  greenhouse: {
    decl_cid: CID.greenhouse,
    surface: 'timeline',
    text: 'Greenhouse east bench — 24.6°C, 61% humidity, soil 34%, CO₂ 640ppm. Nominal.',
    bindings: {
      title: 'Greenhouse — east bench',
      updated_at: Date.now() - 4 * 60 * 1000,
      status: { label: 'nominal', polarity: 'positive' },
      air_temp: { value: 24.6, delta: 0.2, trend: 'up' },
      humidity: { value: 61, delta: 1, trend: 'down' },
      soil: 34,
      co2: 640,
      air_series: [23.1, 23.4, 23.2, 23.8, 24.2, 24.0, 24.5, 24.3, 24.6, 24.4, 24.6, 24.5],
    },
  },

  poll: {
    decl_cid: CID.poll,
    surface: 'timeline',
    text: 'Poll: Saturday work party — morning (3), afternoon (5), skip (1).',
    bindings: {
      question: 'Saturday work party — when?',
      options: [
        { label: 'Morning', share: 3 / 9 },
        { label: 'Afternoon', share: 5 / 9 },
        { label: 'Skip this week', share: 1 / 9 },
      ],
    },
  },

  tasks: {
    decl_cid: CID.task_list,
    surface: 'timeline',
    text: 'atlas: 2 running, 1 queued, 4 done today.',
    bindings: {
      title: 'atlas — task queue',
      summary: { running: 2, queued: 1, done: 4 },
      tasks: [
        { name: 'Index seed catalogue', status: { label: 'running', polarity: 'busy' }, progress: 0.62 },
        { name: 'Summarise sensor logs', status: { label: 'running', polarity: 'busy' }, progress: 0.18 },
        { name: 'Draft irrigation plan', status: { label: 'queued', polarity: 'neutral' }, progress: 0 },
      ],
    },
  },

  agent: {
    decl_cid: CID.agent_panel,
    surface: 'timeline',
    text: 'atlas — online. 2 running, 1 queued. Capabilities: vent.actuate (human-gated), sensors.read (auto).',
    bindings: {
      agent: 'atlas',
      status: { label: 'online', polarity: 'positive' },
      // The embedded task_list (via inlay_ref) inherits this scope, so the
      // panel's bindings must also satisfy that declaration's binds.
      title: 'atlas — task queue',
      summary: { running: 2, queued: 1, done: 4 },
      tasks: [
        { name: 'Index seed catalogue', status: { label: 'running', polarity: 'busy' }, progress: 0.62 },
        { name: 'Draft irrigation plan', status: { label: 'queued', polarity: 'neutral' }, progress: 0 },
      ],
      capabilities: [
        { name: 'sensors.read', policy: { label: 'auto', polarity: 'positive' } },
        { name: 'vent.actuate', policy: { label: 'human-gated', polarity: 'busy' } },
        { name: 'door.unlock', policy: { label: 'forbidden', polarity: 'negative' } },
      ],
    },
  },

  widget: {
    decl_cid: CID.greenhouse,
    surface: 'timeline',
    text: 'Bench 3D view — interactive model of the east bench layout.',
    widget: { component_hash: 'b3:9f2c…', hint: { width: 480, height: 320 } },
  },
}

export const SAMPLE_NAMES = Object.keys(SAMPLES)
