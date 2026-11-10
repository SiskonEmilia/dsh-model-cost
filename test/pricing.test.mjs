// Pricing-engine behavior: window parsing, off-peak matching, and cost math
// against representative LiteLLM cost-map entries.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  dailySeries, dayKey, dayKeysBetween, dayTimeline, indexCostMap, isOffPeak, nextPhaseChange, normalizeOffPeak, parseWeekdays,
  parseWindow, perMillion, phaseAt, priceUsage, rangeWindow, rankCandidates, resolveKey, splitKey, standardRates,
} from '../pricing.js'

/** DeepSeek's shipped schedule: weekdays 00-01, 04-06, and 10-24, plus all weekend. */
const DEEPSEEK_BLOCK = {
  cache_read_input_token_cost: 3e-09,
  input_cost_per_token: 1.5e-07,
  output_cost_per_token: 6e-07,
  windows: [
    { hours_utc: ['00:00-01:00', '04:00-06:00', '10:00-00:00'], weekdays: [1, 2, 3, 4, 5] },
    { hours_utc: '00:00-00:00', weekdays: [6, 7] },
  ],
}

/** Flash's standard entry, matching the shipped map. */
const FLASH_ENTRY = {
  input_cost_per_token: 3e-07,
  output_cost_per_token: 1.2e-06,
  cache_read_input_token_cost: 6e-09,
  cache_creation_input_token_cost: 0,
  offPeak: normalizeOffPeak(DEEPSEEK_BLOCK),
}

/** Monday 2026-11-09 12:30 UTC. */
const MONDAY_NOON = Date.UTC(2026, 10, 9, 12, 30)
/** Monday 2026-11-09 02:00 UTC: the weekday peak gap. */
const MONDAY_NIGHT = Date.UTC(2026, 10, 9, 2, 0)

describe('parseWindow', () => {
  it('reads a plain window', () => {
    assert.deepEqual(parseWindow('10:00-16:30'), { start: 600, end: 990, wholeDay: false })
  })

  it('marks a window whose ends meet as the whole day', () => {
    assert.deepEqual(parseWindow('00:00-00:00'), { start: 0, end: 0, wholeDay: true })
  })

  it('rejects malformed text', () => {
    for (const value of ['', '10:00', '10:00-', 'aa:bb-cc:dd', '24:00-25:00', 42, null]) {
      assert.equal(parseWindow(value), null, String(value))
    }
  })
})

describe('parseWeekdays', () => {
  it('accepts ISO numbers and English names', () => {
    assert.deepEqual([...parseWeekdays([1, 'Tuesday', 'wed'])], [1, 2, 3])
  })

  it('answers null when nothing names a day', () => {
    assert.equal(parseWeekdays([]), null)
    assert.equal(parseWeekdays(['funday']), null)
    assert.equal(parseWeekdays(undefined), null)
  })
})

describe('normalizeOffPeak', () => {
  it('keeps both window forms and the overridden rates', () => {
    const schedule = normalizeOffPeak(DEEPSEEK_BLOCK)
    assert.equal(schedule.rules.length, 2)
    assert.equal(schedule.timeZone, 'UTC')
    assert.equal(schedule.rates.input_cost_per_token, 1.5e-07)
    assert.equal(schedule.rates.output_cost_per_token, 6e-07)
  })

  it('answers null for an entry without windows', () => {
    assert.equal(normalizeOffPeak(undefined), null)
    assert.equal(normalizeOffPeak({ input_cost_per_token: 1 }), null)
    assert.equal(normalizeOffPeak({ hours_utc: 'nonsense' }), null)
  })

  it('honours weekday_timezone for the weekday decision only', () => {
    const schedule = normalizeOffPeak({ ...DEEPSEEK_BLOCK, weekday_timezone: 'Asia/Shanghai' })
    assert.equal(schedule.timeZone, 'Asia/Shanghai')
  })
})

describe('isOffPeak', () => {
  const schedule = normalizeOffPeak(DEEPSEEK_BLOCK)

  it('matches a weekday window that runs to midnight', () => {
    assert.equal(isOffPeak(schedule, MONDAY_NOON), true)
  })

  it('misses the weekday peak gap', () => {
    assert.equal(isOffPeak(schedule, MONDAY_NIGHT), false)
  })

  it('matches every weekend minute', () => {
    // Saturday 2026-11-14 02:00 UTC sits in the weekday gap but not on Saturday.
    assert.equal(isOffPeak(schedule, Date.UTC(2026, 10, 14, 2, 0)), true)
  })

  it('uses the provider timezone to pick the weekday', () => {
    const shifted = normalizeOffPeak({ ...DEEPSEEK_BLOCK, weekday_timezone: 'Asia/Shanghai' })
    // 2026-11-13 23:00 UTC is already Saturday in Shanghai.
    assert.equal(isOffPeak(shifted, Date.UTC(2026, 10, 13, 23, 0)), true)
  })

  it('matches a window that wraps past midnight', () => {
    const wrapping = normalizeOffPeak({ hours_utc: '22:00-02:00', input_cost_per_token: 1 })
    assert.equal(isOffPeak(wrapping, Date.UTC(2026, 10, 9, 23, 0)), true)
    assert.equal(isOffPeak(wrapping, Date.UTC(2026, 10, 9, 1, 0)), true)
    assert.equal(isOffPeak(wrapping, Date.UTC(2026, 10, 9, 12, 0)), false)
  })
})

describe('nextPhaseChange', () => {
  it('finds the boundary that opens the next window', () => {
    const schedule = normalizeOffPeak(DEEPSEEK_BLOCK)
    assert.equal(nextPhaseChange(schedule, MONDAY_NIGHT), Date.UTC(2026, 10, 9, 4, 0))
  })

  it('finds the boundary that closes an open window', () => {
    const schedule = normalizeOffPeak(DEEPSEEK_BLOCK)
    assert.equal(nextPhaseChange(schedule, MONDAY_NOON), Date.UTC(2026, 10, 10, 1, 0))
  })

  it('answers null when every moment is inside', () => {
    assert.equal(nextPhaseChange(normalizeOffPeak({ hours_utc: '00:00-00:00' }), MONDAY_NOON), null)
  })
})

describe('standardRates', () => {
  it('bills an absent cache rate at the input rate', () => {
    const rates = standardRates({ input_cost_per_token: 2e-06, output_cost_per_token: 1e-05 })
    assert.deepEqual(rates, { input: 2e-06, output: 1e-05, cacheRead: 2e-06, cacheWrite: 2e-06 })
  })

  it('prefers the cache-hit rate when the read rate is missing', () => {
    const rates = standardRates({ input_cost_per_token: 2e-06, input_cost_per_token_cache_hit: 1e-07 })
    assert.equal(rates.cacheRead, 1e-07)
  })

  it('treats a missing entry as free rather than throwing', () => {
    assert.deepEqual(standardRates(null), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  })
})

describe('priceUsage', () => {
  const usage = { inputTokens: 1_000, outputTokens: 2_000, cacheReadTokens: 10_000, cacheWriteTokens: 500 }

  it('prices standard rates outside a window', () => {
    const priced = priceUsage(FLASH_ENTRY, usage, MONDAY_NIGHT)
    assert.equal(priced.phase, 'peak')
    assert.equal(priced.cost, 1_000 * 3e-07 + 2_000 * 1.2e-06 + 10_000 * 6e-09 + 0)
  })

  it('prices off-peak rates inside a window', () => {
    const priced = priceUsage(FLASH_ENTRY, usage, MONDAY_NOON)
    assert.equal(priced.phase, 'offpeak')
    assert.equal(priced.cost, 1_000 * 1.5e-07 + 2_000 * 6e-07 + 10_000 * 3e-09 + 0)
  })

  it('reports a flat phase for entries without windows', () => {
    const priced = priceUsage({ input_cost_per_token: 1e-06, output_cost_per_token: 2e-06 }, usage, MONDAY_NOON)
    assert.equal(priced.phase, 'flat')
    assert.equal(priced.cost, 1_000 * 1e-06 + 2_000 * 2e-06 + 10_000 * 1e-06 + 500 * 1e-06)
  })

  it('prices an unresolved route at zero', () => {
    assert.equal(priceUsage(null, usage, MONDAY_NOON).cost, 0)
  })

  it('keeps the per-bucket split that the page shows', () => {
    const priced = priceUsage(FLASH_ENTRY, usage, MONDAY_NOON)
    assert.equal(
      Object.values(priced.buckets).reduce((sum, value) => sum + value, 0),
      priced.cost,
    )
  })
})

describe('phaseAt', () => {
  it('describes the current state and the next flip', () => {
    const phase = phaseAt(FLASH_ENTRY, MONDAY_NIGHT)
    assert.equal(phase.state, 'peak')
    assert.equal(phase.nextAt, Date.UTC(2026, 10, 9, 4, 0))
  })

  it('answers flat with no flip when the entry has no windows', () => {
    const phase = phaseAt({ input_cost_per_token: 1e-06 }, MONDAY_NIGHT)
    assert.equal(phase.state, 'flat')
    assert.equal(phase.nextAt, null)
  })
})

describe('dayTimeline', () => {
  const schedule = normalizeOffPeak(DEEPSEEK_BLOCK)
  /** Tuesday 2026-11-10 04:00 UTC: noon in Shanghai. */
  const TUESDAY_NOON_UTC = Date.UTC(2026, 10, 10, 4, 0)

  it('covers the whole UTC day in contiguous segments', () => {
    assert.deepEqual(dayTimeline(schedule, TUESDAY_NOON_UTC, 'UTC'), [
      { start: '00:00', end: '01:00', state: 'offpeak' },
      { start: '01:00', end: '04:00', state: 'peak' },
      { start: '04:00', end: '06:00', state: 'offpeak' },
      { start: '06:00', end: '10:00', state: 'peak' },
      { start: '10:00', end: '24:00', state: 'offpeak' },
    ])
  })

  it('shifts the same day into the viewer zone and merges touching windows', () => {
    assert.deepEqual(dayTimeline(schedule, TUESDAY_NOON_UTC, 'Asia/Shanghai'), [
      { start: '00:00', end: '09:00', state: 'offpeak' },
      { start: '09:00', end: '12:00', state: 'peak' },
      { start: '12:00', end: '14:00', state: 'offpeak' },
      { start: '14:00', end: '18:00', state: 'peak' },
      { start: '18:00', end: '24:00', state: 'offpeak' },
    ])
  })

  it('covers a whole local weekend day as one off-peak segment', () => {
    // Saturday 2026-11-14 04:00 UTC is Saturday noon in Shanghai.
    assert.deepEqual(dayTimeline(schedule, Date.UTC(2026, 10, 14, 4, 0), 'Asia/Shanghai'), [
      { start: '00:00', end: '24:00', state: 'offpeak' },
    ])
  })

  it('marks a day that matches no rule as peak', () => {
    const mondays = normalizeOffPeak({ hours_utc: '10:00-12:00', weekdays: [1] })
    // Wednesday 2026-11-11 12:00 UTC.
    assert.deepEqual(dayTimeline(mondays, Date.UTC(2026, 10, 11, 12, 0), 'UTC'), [
      { start: '00:00', end: '24:00', state: 'peak' },
    ])
  })

  it('answers no segments when the entry prices no windows', () => {
    assert.deepEqual(dayTimeline(null, TUESDAY_NOON_UTC, 'Asia/Shanghai'), [])
  })

  it('handles a negative-offset zone that wraps past the UTC day', () => {
    // Tuesday 02:00 UTC is Monday evening in New York; that local day runs to Tue 05:00 UTC.
    assert.deepEqual(dayTimeline(schedule, Date.UTC(2026, 10, 10, 2, 0), 'America/New_York'), [
      { start: '00:00', end: '01:00', state: 'offpeak' },
      { start: '01:00', end: '05:00', state: 'peak' },
      { start: '05:00', end: '20:00', state: 'offpeak' },
      { start: '20:00', end: '23:00', state: 'peak' },
      { start: '23:00', end: '24:00', state: 'offpeak' },
    ])
  })
})

describe('perMillion', () => {
  it('scales per-token rates for display', () => {
    assert.deepEqual(perMillion({ input: 3e-07, output: 1.2e-06, cacheRead: 6e-09, cacheWrite: 0 }), {
      input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0,
    })
  })
})

describe('splitKey and rankCandidates', () => {
  it('splits the provider prefix from the model tail', () => {
    assert.deepEqual(splitKey('moonshot/kimi-k3.1-pro'), { prefix: 'moonshot', tail: 'kimi-k3.1-pro' })
    assert.deepEqual(splitKey('deepseek-v4-flash'), { prefix: '', tail: 'deepseek-v4-flash' })
  })

  it('prefers a candidate whose prefix matches the local provider', () => {
    const ranked = rankCandidates(['coralbricks/glm-5.3', 'zai/glm-5.3'], 'zai-coding-cn')
    assert.equal(ranked[0], 'zai/glm-5.3')
  })

  it('falls back to the shortest key', () => {
    const ranked = rankCandidates(['nebius/moonshotai/Kimi-K3.1-Pro', 'moonshot/kimi-k3.1-pro'], 'hg-agent')
    assert.equal(ranked[0], 'moonshot/kimi-k3.1-pro')
  })
})

describe('rangeWindow and dayKey', () => {
  it('bounds the day at local midnight', () => {
    const now = new Date(2026, 10, 9, 15, 0).getTime()
    const range = rangeWindow('today', now)
    assert.equal(range.start, new Date(2026, 10, 9, 0, 0).getTime())
    assert.equal(range.end, now)
  })

  it('spans whole days for relative ranges', () => {
    const now = Date.UTC(2026, 10, 9, 12, 0)
    assert.equal(rangeWindow('7d', now).start, now - 7 * 24 * 60 * 60 * 1000)
    assert.equal(rangeWindow('all', now).start, 0)
  })

  it('formats a local ISO date', () => {
    assert.match(dayKey(new Date(2026, 10, 9, 1, 2).getTime()), /^2026-11-09$/)
  })
})

describe('resolveKey', () => {
  /** A miniature map with an exact key, an alias, and two ambiguous tails. */
  const index = indexCostMap({
    sample_spec: { input_cost_per_token: 0 },
    'deepseek-v4-flash': { input_cost_per_token: 3e-07, output_cost_per_token: 1.2e-06 },
    'deepseek-flash-latest': { alias_of: 'deepseek-v4-flash' },
    'zai/glm-5.3': { input_cost_per_token: 1.4e-06 },
    'coralbricks/glm-5.3': { input_cost_per_token: 1.12e-06 },
    'moonshot/kimi-k3.1-pro': { input_cost_per_token: 2e-06 },
    'vendor/kimi-k3.1-pro': { input_cost_per_token: 9e-06 },
    'solo/only-model': { input_cost_per_token: 1e-06 },
  })

  it('skips the sample entry', () => {
    assert.equal(index.entries.has('sample_spec'), false)
  })

  it('prefers an explicit rule over every heuristic', () => {
    const hit = resolveKey(index, 'zai-coding-cn', 'glm-5.3', [{ provider: 'zai-coding-cn', model: 'glm-5.3', key: 'coralbricks/glm-5.3' }])
    assert.equal(hit.via, 'rule')
    assert.equal(hit.key, 'coralbricks/glm-5.3')
  })

  it('honours a provider-less rule for any provider', () => {
    const hit = resolveKey(index, 'any-gateway', 'glm-5.3', [{ model: 'glm-5.3', key: 'zai/glm-5.3' }])
    assert.equal(hit.key, 'zai/glm-5.3')
    assert.equal(hit.via, 'rule')
  })

  it('matches an exact model key', () => {
    const hit = resolveKey(index, 'hg-agent', 'deepseek-v4-flash', [])
    assert.equal(hit.key, 'deepseek-v4-flash')
    assert.equal(hit.via, 'exact')
  })

  it('follows an alias to the entry that carries rates', () => {
    const hit = resolveKey(index, 'deepseek-official', 'deepseek-flash-latest', [])
    assert.equal(hit.key, 'deepseek-v4-flash')
    assert.equal(hit.entry.input_cost_per_token, 3e-07)
  })

  it('matches a unique model tail without asking for a rule', () => {
    const hit = resolveKey(index, 'gateway', 'only-model', [])
    assert.equal(hit.key, 'solo/only-model')
    assert.equal(hit.via, 'tail')
    assert.equal(hit.ambiguous, false)
  })

  it('marks a several-way tail match as ambiguous', () => {
    const hit = resolveKey(index, 'gateway', 'kimi-k3.1-pro', [])
    assert.equal(hit.ambiguous, true)
    assert.ok(hit.candidates.length >= 2)
  })

  it('ranks an ambiguous tail by provider affinity', () => {
    const hit = resolveKey(index, 'coralbricks-proxy', 'glm-5.3', [])
    assert.equal(hit.key, 'coralbricks/glm-5.3')
    assert.equal(hit.ambiguous, true)
    assert.ok(hit.candidates.includes('zai/glm-5.3'))
  })

  it('answers null for an unknown model', () => {
    assert.equal(resolveKey(index, 'gateway', 'not-a-model', []), null)
    assert.equal(resolveKey(index, 'gateway', '', []), null)
  })
})

describe('dayKeysBetween', () => {
  it('walks three consecutive days', () => {
    assert.deepEqual(dayKeysBetween('2026-11-08', '2026-11-10'), ['2026-11-08', '2026-11-09', '2026-11-10'])
  })

  it('crosses a month boundary', () => {
    assert.deepEqual(dayKeysBetween('2026-10-30', '2026-11-02'),
      ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'])
  })

  it('returns one key when both ends meet', () => {
    assert.deepEqual(dayKeysBetween('2026-11-10', '2026-11-10'), ['2026-11-10'])
  })

  it('stops at the safety cap', () => {
    assert.equal(dayKeysBetween('2026-01-01', '2026-12-31', 10).length, 10)
  })
})

describe('dailySeries', () => {
  /** One day's report bucket. */
  const bucket = (cost, peakCost, offpeakCost, requests) => ({ cost, peakCost, offpeakCost, requests })

  it('fills the quiet days of a trailing week', () => {
    const end = new Date(2026, 10, 10, 15, 30).getTime()
    const days = new Map([['2026-11-10', bucket(1, 0.4, 0.6, 3)]])
    const series = dailySeries(days, { id: '7d', start: 0, end })
    assert.equal(series.length, 7)
    assert.equal(series[0].date, '2026-11-04')
    assert.equal(series[6].date, '2026-11-10')
    assert.deepEqual(series[6], {
      date: '2026-11-10', cost: 1, peakCost: 0.4, offpeakCost: 0.6, requests: 3,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    })
    assert.equal(series[0].cost, 0)
    assert.equal(series[0].requests, 0)
  })

  it('keeps exactly one bucket for today', () => {
    const series = dailySeries(new Map(), { id: 'today', start: 0, end: Date.now() })
    assert.equal(series.length, 1)
    assert.equal(series[0].date, dayKey(Date.now()))
  })

  it('starts all-time at the oldest recorded day and keeps totals', () => {
    const end = new Date(2026, 10, 10, 9, 0).getTime()
    const days = new Map([
      ['2026-11-01', bucket(2, 0, 2, 1)],
      ['2026-11-10', bucket(3, 3, 0, 4)],
    ])
    const series = dailySeries(days, { id: 'all', start: 0, end })
    assert.equal(series.length, 10)
    assert.equal(series[0].date, '2026-11-01')
    assert.equal(series.at(-1).date, '2026-11-10')
    assert.equal(series[2].requests, 0)
    assert.equal(series.reduce((sum, day) => sum + day.cost, 0), 5)
    assert.equal(series.reduce((sum, day) => sum + day.requests, 0), 5)
  })

  it('keeps a single bucket for an empty all-time range', () => {
    const series = dailySeries(new Map(), { id: 'all', start: 0, end: Date.now() })
    assert.equal(series.length, 1)
    assert.equal(series[0].cost, 0)
  })
})
