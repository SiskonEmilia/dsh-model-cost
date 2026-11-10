/**
 * Pure pricing engine over the LiteLLM Model Cost Map.
 *
 * Everything here is a function of a cost-map entry, a token-usage record, and
 * an instant, so the shipped pricing rules are unit-testable without the
 * harness. Rates follow LiteLLM: every price is USD per billable token, cache
 * buckets bill separately, and an `off_peak_pricing` window replaces the
 * standard rates for the requests whose completion time falls inside it.
 *
 * @module dsh-model-cost/pricing
 */

/** Token-rate fields a cost-map entry may price, in display order. */
export const RATE_FIELDS = [
  'input_cost_per_token',
  'output_cost_per_token',
  'cache_read_input_token_cost',
  'cache_creation_input_token_cost',
  'output_cost_per_reasoning_token',
]

const WEEKDAY_INDEX = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 }
const MINUTE_MS = 60_000

/**
 * Count helper that accepts only finite non-negative numbers.
 * @param {unknown} value - raw counter.
 * @returns {number} the counter, or 0.
 */
export function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Parse one `"HH:MM-HH:MM"` window.
 * @param {unknown} text - window text.
 * @returns {{start:number,end:number,wholeDay:boolean}|null} minutes-of-day window, or null when malformed.
 */
export function parseWindow(text) {
  if (typeof text !== 'string') return null
  const match = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (match === null) return null
  const start = Number(match[1]) * 60 + Number(match[2])
  const end = Number(match[3]) * 60 + Number(match[4])
  if (start > 1439 || end > 1439) return null
  return { start, end, wholeDay: start === end }
}

/**
 * Parse one weekday list of ISO numbers or English names/abbreviations.
 * @param {unknown} value - weekday list.
 * @returns {Set<number>|null} ISO weekday numbers, or null when the list names nothing.
 */
export function parseWeekdays(value) {
  if (!Array.isArray(value) || value.length === 0) return null
  const days = new Set()
  for (const item of value) {
    if (typeof item === 'number' && Number.isInteger(item) && item >= 1 && item <= 7) days.add(item)
    else if (typeof item === 'string') {
      const named = WEEKDAY_INDEX[item.trim().slice(0, 3).toLowerCase()]
      if (named !== undefined) days.add(named)
    }
  }
  return days.size === 0 ? null : days
}

/**
 * Normalize a cost-map entry's `off_peak_pricing` block.
 *
 * `hours_utc` at the top level (with an optional `weekdays` list) and each
 * `windows` rule contribute windows; a rule without `weekdays` applies every day.
 * @param {unknown} block - raw block from the cost map.
 * @returns {{rules:{windows:{start:number,end:number,wholeDay:boolean}[],weekdays:Set<number>|null}[],rates:Record<string,number>,timeZone:string}|null} normalized schedule, or null when the entry prices no windows.
 */
export function normalizeOffPeak(block) {
  if (typeof block !== 'object' || block === null) return null
  const rules = []
  const addRule = (hours, weekdays) => {
    const texts = Array.isArray(hours) ? hours : [hours]
    const windows = texts.map(parseWindow).filter(window => window !== null)
    if (windows.length === 0) return
    rules.push({ windows, weekdays: parseWeekdays(weekdays) })
  }
  addRule(block.hours_utc, block.weekdays)
  if (Array.isArray(block.windows)) {
    for (const rule of block.windows) {
      if (typeof rule === 'object' && rule !== null) addRule(rule.hours_utc, rule.weekdays)
    }
  }
  if (rules.length === 0) return null
  const rates = {}
  for (const field of RATE_FIELDS) {
    if (typeof block[field] === 'number' && Number.isFinite(block[field])) rates[field] = block[field]
  }
  const timeZone = typeof block.weekday_timezone === 'string' && block.weekday_timezone !== ''
    ? block.weekday_timezone
    : 'UTC'
  return { rules, rates, timeZone }
}

const weekdayFormatters = new Map()

/**
 * Read the calendar weekday of an instant in one IANA zone.
 * @param {number} timeMs - epoch milliseconds.
 * @param {string} timeZone - IANA zone; an unknown name falls back to UTC.
 * @returns {number} ISO weekday, 1 = Monday.
 */
export function isoWeekday(timeMs, timeZone) {
  let formatter = weekdayFormatters.get(timeZone)
  if (formatter === undefined) {
    try {
      formatter = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' })
    } catch (_unknownZone) {
      formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' })
    }
    weekdayFormatters.set(timeZone, formatter)
  }
  const name = formatter.format(new Date(timeMs)).slice(0, 3).toLowerCase()
  return WEEKDAY_INDEX[name] ?? 1
}

/**
 * Whether one instant falls inside the off-peak schedule.
 * @param {{rules:{windows:{start:number,end:number,wholeDay:boolean}[],weekdays:Set<number>|null}[],timeZone:string}} schedule - normalized schedule.
 * @param {number} timeMs - epoch milliseconds.
 * @returns {boolean} true inside any configured window.
 */
export function isOffPeak(schedule, timeMs) {
  const date = new Date(timeMs)
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes()
  for (const rule of schedule.rules) {
    if (rule.weekdays !== null && !rule.weekdays.has(isoWeekday(timeMs, schedule.timeZone))) continue
    for (const window of rule.windows) {
      if (window.wholeDay) return true
      if (window.start < window.end) {
        if (minute >= window.start && minute < window.end) return true
      } else if (minute >= window.start || minute < window.end) return true
    }
  }
  return false
}

/**
 * Find when the off-peak state next flips.
 * @param {{rules:{windows:{start:number,end:number,wholeDay:boolean}[],weekdays:Set<number>|null}[],timeZone:string}} schedule - normalized schedule.
 * @param {number} timeMs - epoch milliseconds.
 * @returns {number|null} epoch milliseconds of the next flip within eight days, or null when the state never changes.
 */
export function nextPhaseChange(schedule, timeMs) {
  const current = isOffPeak(schedule, timeMs)
  const firstMinute = Math.ceil(timeMs / MINUTE_MS) * MINUTE_MS
  for (let step = 1; step <= 8 * 1440; step += 1) {
    const at = firstMinute + step * MINUTE_MS
    if (isOffPeak(schedule, at) !== current) return at
  }
  return null
}

/**
 * Read one numeric rate field from an entry or an override block.
 * @param {Record<string, unknown>} source - entry or off-peak override.
 * @param {string} field - rate field name.
 * @returns {number|undefined} the rate when the field is a finite number.
 */
function rateField(source, field) {
  const value = source?.[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Standard per-token rates of one entry, ignoring any off-peak window.
 *
 * A cache rate the entry omits bills at the entry's input rate, matching
 * LiteLLM: an unpriced cache bucket is not free.
 * @param {Record<string, unknown>|null} entry - cost-map entry.
 * @returns {{input:number,output:number,cacheRead:number,cacheWrite:number}} rates.
 */
export function standardRates(entry) {
  const input = rateField(entry, 'input_cost_per_token') ?? 0
  return {
    input,
    output: rateField(entry, 'output_cost_per_token') ?? 0,
    cacheRead: rateField(entry, 'cache_read_input_token_cost')
      ?? rateField(entry, 'input_cost_per_token_cache_hit')
      ?? input,
    cacheWrite: rateField(entry, 'cache_creation_input_token_cost') ?? input,
  }
}

/**
 * Effective per-token rates of one entry at one instant.
 * @param {Record<string, unknown>|null} entry - cost-map entry.
 * @param {number} timeMs - completion instant.
 * @returns {{input:number,output:number,cacheRead:number,cacheWrite:number,windows:object|null}} rates; a missing cache rate bills at the input rate.
 */
export function ratesAt(entry, timeMs) {
  const schedule = entry?.offPeak ?? null
  const standard = standardRates(entry)
  if (schedule === null || !isOffPeak(schedule, timeMs)) return { ...standard, windows: schedule }
  return {
    input: schedule.rates.input_cost_per_token ?? standard.input,
    output: schedule.rates.output_cost_per_token ?? standard.output,
    cacheRead: schedule.rates.cache_read_input_token_cost ?? standard.cacheRead,
    cacheWrite: schedule.rates.cache_creation_input_token_cost ?? standard.cacheWrite,
    windows: schedule,
  }
}

/**
 * Price one call's usage.
 * @param {Record<string, unknown>|null} entry - cost-map entry, or null when unpriced.
 * @param {{inputTokens:number,outputTokens:number,cacheReadTokens:number,cacheWriteTokens:number}} usage - disjoint token counts.
 * @param {number} timeMs - completion instant.
 * @returns {{cost:number,buckets:{input:number,cacheRead:number,cacheWrite:number,output:number},phase:'peak'|'offpeak'|'flat',rates:ReturnType<typeof ratesAt>}} priced call.
 */
export function priceUsage(entry, usage, timeMs) {
  const rates = ratesAt(entry, timeMs)
  const buckets = {
    input: usage.inputTokens * rates.input,
    cacheRead: usage.cacheReadTokens * rates.cacheRead,
    cacheWrite: usage.cacheWriteTokens * rates.cacheWrite,
    output: usage.outputTokens * rates.output,
  }
  return {
    cost: buckets.input + buckets.cacheRead + buckets.cacheWrite + buckets.output,
    buckets,
    phase: rates.windows === null ? 'flat' : isOffPeak(rates.windows, timeMs) ? 'offpeak' : 'peak',
    rates,
  }
}

/**
 * Current phase of one entry, with the instant it next changes.
 * @param {Record<string, unknown>|null} entry - cost-map entry.
 * @param {number} timeMs - instant to evaluate.
 * @returns {{state:'peak'|'offpeak'|'flat',nextAt:number|null,rates:ReturnType<typeof ratesAt>}} phase facts.
 */
export function phaseAt(entry, timeMs) {
  const rates = ratesAt(entry, timeMs)
  if (rates.windows === null) return { state: 'flat', nextAt: null, rates }
  return {
    state: isOffPeak(rates.windows, timeMs) ? 'offpeak' : 'peak',
    nextAt: nextPhaseChange(rates.windows, timeMs),
    rates,
  }
}

/**
 * Convert per-token rates into per-million-token display values.
 * @param {{input:number,output:number,cacheRead:number,cacheWrite:number}} rates - per-token rates.
 * @returns {{input:number,output:number,cacheRead:number,cacheWrite:number}} per-million rates.
 */
export function perMillion(rates) {
  return {
    input: rates.input * 1_000_000,
    output: rates.output * 1_000_000,
    cacheRead: rates.cacheRead * 1_000_000,
    cacheWrite: rates.cacheWrite * 1_000_000,
  }
}

/**
 * Split a cost-map key into its provider prefix and model tail.
 * @param {string} key - full cost-map key.
 * @returns {{prefix:string,tail:string}} lowercase parts.
 */
export function splitKey(key) {
  const index = key.lastIndexOf('/')
  return index < 0
    ? { prefix: '', tail: key.toLowerCase() }
    : { prefix: key.slice(0, index).toLowerCase(), tail: key.slice(index + 1).toLowerCase() }
}

/**
 * Rank tail-match candidates for one provider: a candidate whose key prefix
 * shares a token with the provider name wins, then the shortest key.
 * @param {string[]} candidates - cost-map keys whose model tail matches.
 * @param {string} provider - local route provider.
 * @returns {string[]} candidates, best first.
 */
export function rankCandidates(candidates, provider) {
  const token = provider.toLowerCase()
  const parts = token.split(/[^a-z0-9]+/).filter(part => part !== '')
  const score = key => {
    const prefix = splitKey(key).prefix
    if (prefix === '') return 2
    const prefixParts = prefix.split(/[^a-z0-9]+/).filter(part => part !== '')
    if (token.includes(prefix) || prefixParts.some(part => token.includes(part))) return 3
    return prefixParts.some(part => part.includes(token) || parts.some(local => part.includes(local))) ? 2 : 1
  }
  return [...candidates].sort((left, right) => score(right) - score(left)
    || left.length - right.length
    || left.localeCompare(right))
}

/**
 * Resolve a report range id into inclusive epoch bounds.
 * @param {string} id - `all`, `today`, `7d`, or `30d`.
 * @param {number} now - current instant.
 * @returns {{id:string,start:number,end:number}} bounds.
 */
export function rangeWindow(id, now) {
  if (id === 'today') {
    const midnight = new Date(now)
    midnight.setHours(0, 0, 0, 0)
    return { id, start: midnight.getTime(), end: now }
  }
  if (id === '7d' || id === '30d') {
    const days = id === '7d' ? 7 : 30
    return { id, start: now - days * 24 * 60 * MINUTE_MS, end: now }
  }
  return { id: 'all', start: 0, end: now }
}

/**
 * ISO date (local) of one instant.
 * @param {number} timeMs - epoch milliseconds.
 * @returns {string} `YYYY-MM-DD`.
 */
export function dayKey(timeMs) {
  const date = new Date(timeMs)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * Every local date key from `first` through `last`, inclusive. A series needs
 * the quiet days too, otherwise a chart jumps over stretches with no usage.
 * @param {string} first - `YYYY-MM-DD`.
 * @param {string} last - `YYYY-MM-DD`.
 * @param {number} [limit] - safety cap on the number of keys.
 * @returns {string[]} consecutive date keys, oldest first.
 */
export function dayKeysBetween(first, last, limit = 1200) {
  const keys = []
  const [startYear, startMonth, startDay] = first.split('-').map(Number)
  const [endYear, endMonth, endDay] = last.split('-').map(Number)
  if (![startYear, startMonth, startDay, endYear, endMonth, endDay].every(Number.isFinite)) return keys
  const end = new Date(endYear, endMonth - 1, endDay).getTime()
  const cursor = new Date(startYear, startMonth - 1, startDay)
  while (cursor.getTime() <= end && keys.length < limit) {
    keys.push(dayKey(cursor.getTime()))
    // Calendar arithmetic, so a DST shift cannot skip or repeat a day.
    cursor.setDate(cursor.getDate() + 1)
  }
  return keys
}

/**
 * Turn per-day buckets into a continuous, gap-filled series over a report
 * range: a trend must read as elapsed time, not as "days that had usage".
 * @param {Map<string, object>} days - buckets keyed by local date.
 * @param {{id:string,start:number,end:number}} range - report range.
 * @returns {object[]} one entry per date, oldest first.
 */
export function dailySeries(days, range) {
  const last = dayKey(range.end)
  let first = last
  if (range.id === 'all') {
    // All-time starts at the oldest day that recorded usage.
    for (const date of days.keys()) if (date < first) first = date
  } else if (range.id === '7d' || range.id === '30d') {
    // Trailing ranges are day counts: align the first bucket to midnight so
    // the window holds exactly 7 or 30 bars, today being the last.
    const anchor = new Date(range.end)
    anchor.setHours(0, 0, 0, 0)
    anchor.setDate(anchor.getDate() - (range.id === '7d' ? 6 : 29))
    first = dayKey(anchor.getTime())
  }
  const series = []
  for (const date of dayKeysBetween(first, last)) {
    const bucket = days.get(date)
    series.push({
      date,
      cost: bucket?.cost ?? 0,
      peakCost: bucket?.peakCost ?? 0,
      offpeakCost: bucket?.offpeakCost ?? 0,
      requests: bucket?.requests ?? 0,
      inputTokens: bucket?.inputTokens ?? 0,
      outputTokens: bucket?.outputTokens ?? 0,
      cacheReadTokens: bucket?.cacheReadTokens ?? 0,
      cacheWriteTokens: bucket?.cacheWriteTokens ?? 0,
    })
  }
  return series
}

/**
 * The last calendar day present in a bucket map, or null when it is empty.
 * @param {Map<string, object>} days - buckets keyed by local date.
 * @returns {string|null} newest `YYYY-MM-DD`.
 */
export function lastDayOf(days) {
  let last = null
  for (const date of days.keys()) if (last === null || date > last) last = date
  return last
}

/**
 * Bucket the priced calls of one calendar day into 24 hourly buckets. A single
 * day is too little for a daily chart, so the page reads it as a timeline.
 * @param {{time:number,phase:string,cost:number,inputTokens:number,outputTokens:number,cacheReadTokens:number,cacheWriteTokens:number}[]} calls - priced calls of any day.
 * @param {string} date - local `YYYY-MM-DD` to keep.
 * @returns {object[]} 24 buckets, hour 0 through 23.
 */
export function hourBuckets(calls, date) {
  const buckets = []
  for (let hour = 0; hour < 24; hour += 1) {
    buckets.push({
      hour,
      cost: 0, peakCost: 0, offpeakCost: 0, requests: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    })
  }
  for (const call of calls) {
    if (dayKey(call.time) !== date) continue
    const bucket = buckets[new Date(call.time).getHours()]
    if (bucket === undefined) continue
    bucket.cost += call.cost
    if (call.phase === 'peak') bucket.peakCost += call.cost
    else if (call.phase === 'offpeak') bucket.offpeakCost += call.cost
    bucket.requests += 1
    bucket.inputTokens += call.inputTokens
    bucket.outputTokens += call.outputTokens
    bucket.cacheReadTokens += call.cacheReadTokens
    bucket.cacheWriteTokens += call.cacheWriteTokens
  }
  return buckets
}

const zoneFormatters = new Map()

/**
 * Read the wall-clock parts of one instant in a zone.
 * @param {number} timeMs - epoch milliseconds.
 * @param {string} timeZone - IANA zone.
 * @returns {{year:number,month:number,day:number,hour:number,minute:number}} numeric parts.
 */
function zonedParts(timeMs, timeZone) {
  let formatter = zoneFormatters.get(timeZone)
  if (formatter === undefined) {
    const options = {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    }
    try {
      formatter = new Intl.DateTimeFormat('en-US', options)
    } catch (_unknownZone) {
      formatter = new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' })
    }
    zoneFormatters.set(timeZone, formatter)
  }
  const parts = {}
  for (const part of formatter.formatToParts(new Date(timeMs))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value)
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour === 24 ? 0 : parts.hour,
    minute: parts.minute,
  }
}

/**
 * Offset between a zone's wall clock and UTC at one instant.
 * @param {number} timeMs - epoch milliseconds.
 * @param {string} timeZone - IANA zone.
 * @returns {number} milliseconds to subtract from the wall clock to reach UTC.
 */
function zoneOffsetMs(timeMs, timeZone) {
  const parts = zonedParts(timeMs, timeZone)
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - Math.floor(timeMs / 60000) * 60000
}

/**
 * Epoch instant of one local midnight.
 * @param {number} year - calendar year.
 * @param {number} month - calendar month, 1-based.
 * @param {number} day - calendar day.
 * @param {string} timeZone - IANA zone.
 * @returns {number} epoch milliseconds.
 */
function zonedMidnight(year, month, day, timeZone) {
  const wall = Date.UTC(year, month - 1, day)
  let instant = wall - zoneOffsetMs(wall, timeZone)
  instant = wall - zoneOffsetMs(instant, timeZone)
  return instant
}

/**
 * Format a local wall-clock time.
 * @param {number} timeMs - epoch milliseconds.
 * @param {string} timeZone - IANA zone.
 * @returns {string} `HH:MM`.
 */
function zonedClock(timeMs, timeZone) {
  const parts = zonedParts(timeMs, timeZone)
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`
}

/**
 * Tariff segments of the viewer's current calendar day, in the viewer's zone.
 *
 * The schedule is declared in UTC with its own weekday rules, so the day is
 * resolved by walking that zone's local day and asking the schedule at each
 * minute; segments are contiguous and cover `00:00`..`24:00`, and a run that
 * crosses midnight is clipped to the visible day.
 * @param {object} schedule - normalized schedule from {@link normalizeOffPeak}.
 * @param {number} now - current instant.
 * @param {string} timeZone - viewer's IANA zone.
 * @returns {{start:string,end:string,state:'peak'|'offpeak'}[]} segments as local `HH:MM`.
 */
export function dayTimeline(schedule, now, timeZone) {
  if (schedule === null) return []
  const today = zonedParts(now, timeZone)
  const start = zonedMidnight(today.year, today.month, today.day, timeZone)
  const tomorrow = new Date(Date.UTC(today.year, today.month - 1, today.day + 1))
  const end = zonedMidnight(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), timeZone)
  const segments = []
  let state = null
  let from = start
  for (let at = start; at < end; at += MINUTE_MS) {
    const atState = isOffPeak(schedule, at) ? 'offpeak' : 'peak'
    if (state === null) {
      state = atState
      from = at
      continue
    }
    if (atState === state) continue
    segments.push({ start: zonedClock(from, timeZone), end: zonedClock(at, timeZone), state })
    state = atState
    from = at
  }
  segments.push({ start: zonedClock(from, timeZone), end: '24:00', state })
  return segments
}

/**
 * Normalize one raw cost-map entry for indexing.
 * @param {Record<string, unknown>} raw - entry from the map file.
 * @returns {Record<string, unknown>} entry with a normalized off-peak schedule.
 */
export function normalizeEntry(raw) {
  const { off_peak_pricing: offPeakBlock, ...rest } = raw
  return { ...rest, offPeak: normalizeOffPeak(offPeakBlock) }
}

/**
 * Build the lookup indexes over one cost map.
 * @param {Record<string, Record<string, unknown>>} entries - raw entries keyed by cost-map key.
 * @returns {{entries:Map<string,object>,exact:Map<string,string>,tails:Map<string,string[]>,alphabetical:string[]}} index.
 */
export function indexCostMap(entries) {
  const normalized = new Map()
  const exact = new Map()
  const tails = new Map()
  for (const [key, raw] of Object.entries(entries)) {
    if (key === 'sample_spec') continue
    normalized.set(key, normalizeEntry(raw))
    exact.set(key.toLowerCase(), key)
    const { tail } = splitKey(key)
    const bucket = tails.get(tail)
    if (bucket === undefined) tails.set(tail, [key])
    else bucket.push(key)
  }
  return { entries: normalized, exact, tails, alphabetical: [...normalized.keys()].sort() }
}

/**
 * Follow `alias_of` links to the entry that carries rates.
 * @param {Map<string, object>} entries - normalized entries.
 * @param {string} key - starting key.
 * @returns {{key:string,entry:object}|null} terminal entry, or null when the chain breaks or cycles.
 */
export function resolveAlias(entries, key) {
  let current = key
  for (let hops = 0; hops < 8; hops += 1) {
    const entry = entries.get(current)
    if (entry === undefined) return null
    if (typeof entry.alias_of !== 'string') return { key: current, entry }
    current = entry.alias_of
  }
  return null
}

/**
 * Resolve the cost-map key one route prices with.
 *
 * An explicit rule wins, then an exact key (`model` or `provider/model`), then
 * a unique model-tail match. A tail match with several candidates still
 * answers — ranked by provider affinity — but is marked ambiguous so the page
 * can ask for an explicit rule.
 * @param {object} index - index built by {@link indexCostMap}.
 * @param {string|null} provider - route provider.
 * @param {string|null} model - route model id.
 * @param {{provider?:string,model:string,key:string}[]} rules - deployment mapping rules.
 * @returns {{key:string,entry:object,via:'rule'|'exact'|'tail',ambiguous:boolean,candidates?:string[]}|null} resolution.
 */
export function resolveKey(index, provider, model, rules = []) {
  if (typeof model !== 'string' || model === '') return null
  const lowerModel = model.toLowerCase()
  const lowerProvider = typeof provider === 'string' ? provider.toLowerCase() : null
  const rule = (lowerProvider === null
    ? undefined
    : rules.find(candidate => candidate.provider?.toLowerCase() === lowerProvider && candidate.model.toLowerCase() === lowerModel))
    ?? rules.find(candidate => candidate.provider === undefined && candidate.model.toLowerCase() === lowerModel)
  if (rule !== undefined) {
    const alias = resolveAlias(index.entries, rule.key)
    if (alias !== null) return { key: alias.key, entry: alias.entry, via: 'rule', ambiguous: false }
  }
  for (const candidate of [lowerModel, lowerProvider === null ? null : `${lowerProvider}/${lowerModel}`]) {
    if (candidate === null) continue
    const exact = index.exact.get(candidate)
    if (exact === undefined) continue
    const alias = resolveAlias(index.entries, exact)
    if (alias !== null) return { key: alias.key, entry: alias.entry, via: 'exact', ambiguous: false }
  }
  const tailMatches = index.tails.get(lowerModel) ?? []
  if (tailMatches.length === 0) return null
  const ranked = tailMatches.length === 1 ? tailMatches : rankCandidates(tailMatches, provider ?? '')
  for (const candidate of ranked) {
    const alias = resolveAlias(index.entries, candidate)
    if (alias === null) continue
    return tailMatches.length === 1
      ? { key: alias.key, entry: alias.entry, via: 'tail', ambiguous: false }
      : { key: alias.key, entry: alias.entry, via: 'tail', ambiguous: true, candidates: ranked.slice(0, 8) }
  }
  return null
}
