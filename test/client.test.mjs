// Browser half: the composer pill reports one delegation tree — the Session's
// own calls plus the subagent Sessions it spawned — and the panel splits them.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { loadClient, renderPill } from './support/client-runtime.mjs'

const { costPill } = await loadClient()

/** Totals in the shape the host folds. */
function totals({ cost, requests = 10, peakCost = 0, offpeakCost = 0 }) {
  return {
    cost,
    requests,
    pricedRequests: requests,
    unpricedRequests: 0,
    peakCost,
    offpeakCost,
    inputTokens: 1_000_000,
    outputTokens: 200_000,
    cacheReadTokens: 9_000_000,
    cacheWriteTokens: 0,
  }
}

/**
 * Add two totals, as the host's `combined` does.
 * @param {object} left - own totals.
 * @param {object} right - subagent totals.
 * @returns {object} summed totals.
 */
function sum(left, right) {
  const total = { ...left }
  for (const key of Object.keys(total)) total[key] = left[key] + right[key]
  return total
}

/** One host session summary, with a subagent roll-up unless it is switched off. */
function summary({ own = totals({ cost: 4.9472, requests: 140 }), agents = null, external = 0, complete = true } = {}) {
  const hasRollup = agents !== null || external > 0
  const subagentTotals = agents === null
    ? totals({ cost: 0, requests: 0 })
    : totals({ cost: agents.reduce((running, entry) => running + entry.cost, 0), requests: 25 })
  const combined = sum(own, subagentTotals)
  return {
    sessionId: 'session-parent',
    updatedAt: 1,
    hasUsage: true,
    totals: own,
    ...hasRollup ? {
      subagents: {
        totals: subagentTotals,
        agents: agents ?? [],
        count: agents?.length ?? 0,
        external,
        complete,
        hasUsage: subagentTotals.requests > 0,
      },
    } : {},
    ...hasRollup ? { combined } : {},
    inherited: null,
    models: [],
    phase: {
      provider: 'zai-coding-cn',
      model: 'glm-5.3',
      key: 'zai/glm-5.3',
      via: 'exact',
      state: 'flat',
      nextAt: null,
      nextState: null,
      rates: { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 },
      standard: { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 },
      timeZone: 'UTC',
      timeline: [],
      hasSchedule: false,
      source: null,
    },
    map: { source: 'LiteLLM', sourceUrl: 'https://example.invalid', generatedAt: null, origin: 'snapshot', entries: 1 },
  }
}

const agent = (id, label, cost) => ({
  id,
  label,
  parentId: 'session-parent',
  depth: 1,
  provider: 'zai-coding-cn',
  model: 'glm-5.3',
  hasUsage: true,
  cost,
  requests: 21,
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 1,
  cacheWriteTokens: 0,
  peakCost: 0,
  offpeakCost: 0,
})

describe('composer cost pill', () => {
  it('shows the Session plus its subagents and how many there are', () => {
    const rendered = renderPill(costPill, summary({
      agents: [agent('kid-1', 'Find the payload', 0.5871), agent('kid-2', 'Research versions', 0.1488)],
    }))
    assert.ok(rendered.texts.includes('$5.68'))
    assert.ok(rendered.texts.includes('pillAgents(count=2)'))
    assert.ok(!rendered.texts.includes('$4.95'))
  })

  it('keeps a Session without subagents to its own amount', () => {
    const rendered = renderPill(costPill, summary())
    assert.ok(rendered.texts.includes('$4.95'))
    assert.ok(!rendered.texts.some(text => text.startsWith('pillAgents')))
    assert.ok(!rendered.panelTexts.includes('dialogSubagents'))
  })

  it('splits own and subagent spend in the panel', () => {
    const rendered = renderPill(costPill, summary({
      agents: [agent('kid-1', 'Find the payload', 0.5871), agent('kid-2', 'Research versions', 0.1488)],
    }))
    assert.ok(rendered.panelTexts.includes('dialogOwn'))
    assert.ok(rendered.panelTexts.includes('$4.95 · dialogCalls(count=140)'))
    assert.ok(rendered.panelTexts.includes('dialogSubagents'))
    assert.ok(rendered.panelTexts.includes('$0.736 · dialogCalls(count=25) · pillAgents(count=2)'))
    // The headline and the per-request/token rows describe the whole tree.
    assert.ok(rendered.panelTexts.includes('dialogTokens'))
    assert.ok(rendered.panelTexts.includes('2.0M · 18M · 400K'))
    assert.ok(rendered.panelTexts.includes('165'))
    assert.ok(rendered.panelTexts.includes('dialogAgents'))
    assert.ok(rendered.panelTexts.includes('Find the payload'))
    assert.ok(rendered.panelTexts.includes('Research versions'))
    assert.ok(rendered.panelTexts.includes('$0.587'))
    assert.ok(rendered.panelTexts.includes('$0.149'))
  })

  it('warns when part of the delegation could not be read', () => {
    const rendered = renderPill(costPill, summary({ agents: [agent('kid-1', 'Find the payload', 0.5871)], complete: false }))
    assert.ok(rendered.panelTexts.includes('dialogAgentsIncomplete'))
  })

  it('says when external subagents are left unpriced', () => {
    const rendered = renderPill(costPill, summary({ agents: [agent('kid-1', 'Find the payload', 0.5871)], external: 2 }))
    assert.ok(rendered.panelTexts.includes('dialogAgentsExternal(count=2)'))
  })

  it('explains an external-only delegation without inventing a cost', () => {
    const rendered = renderPill(costPill, summary({ external: 1 }))
    assert.ok(rendered.texts.includes('$4.95'))
    assert.ok(!rendered.texts.some(text => text.startsWith('pillAgents')))
    assert.ok(!rendered.panelTexts.includes('dialogSubagents'))
    assert.ok(rendered.panelTexts.includes('dialogAgentsExternal(count=1)'))
  })

  it('still renders against an older host that reports no roll-up', () => {
    const legacy = summary()
    delete legacy.subagents
    delete legacy.combined
    const rendered = renderPill(costPill, legacy)
    assert.ok(rendered.texts.includes('$4.95'))
    assert.ok(!rendered.texts.some(text => text.startsWith('pillAgents')))
  })
})
