/**
 * Session-log reading for cost accounting.
 *
 * The cost map prices calls from `assistant/message` usage, and the route a call
 * billed under comes from the nearest preceding `request/header` or
 * `request/context`. A forked Session's log starts with a copy of its parent's
 * events, so the reader must skip that inherited prefix: those calls were billed
 * once, under the parent.
 *
 * {@link scanSessionLog} adds the incremental form: a log that only appended
 * continues from the earlier cut instead of being read again.
 *
 * @module dsh-model-cost/usage
 */
import { count } from './pricing.js'

/**
 * Read the priced-call inputs out of one Session's raw event log.
 *
 * Positions at or after `from` are read. Calls before `inheritedEventCount`
 * belong to the fork parent and land in `inheritedItems`: global totals ignore
 * them, while the Session dialog shows them as the pre-fork amount. Pass
 * `route` when continuing an earlier read.
 * @param {readonly object[]} events - the Session's raw log, inherited prefix included.
 * @param {{from?: number, inherited?: number, route?: {provider:string,model:string}|null}} [options] - read window and starting route.
 * @returns {{items: object[], inheritedItems: object[], route: {provider:string,model:string}|null, lastSeq: number}} own usage rows, inherited usage rows, the route now in force, and the log's last seq.
 */
export function scanUsage(events, options = {}) {
  const from = Number.isInteger(options.from) && options.from > 0 ? options.from : 0
  const inherited = Number.isInteger(options.inherited) && options.inherited > 0 ? options.inherited : 0
  const items = []
  // Kept apart for the Session dialog, which shows "after the fork (+ before
  // the fork)"; global totals only ever read `items`.
  const inheritedItems = []
  let route = options.route ?? null
  for (let position = from; position < events.length; position += 1) {
    const event = events[position]
    if (event.type === 'request/header') {
      const config = event.data?.header?.config
      if (typeof config?.provider === 'string' && typeof config?.model === 'string') {
        route = { provider: config.provider, model: config.model }
      }
    } else if (event.type === 'request/context') {
      const context = event.data
      if (typeof context?.provider === 'string' && typeof context?.model === 'string') {
        route = { provider: context.provider, model: context.model }
      }
    } else if (event.type === 'assistant/message') {
      const usage = event.data?.usage
      if (typeof usage !== 'object' || usage === null) continue
      const row = {
        seq: event.seq,
        time: event.time,
        provider: route?.provider ?? null,
        model: route?.model ?? null,
        inputTokens: count(usage.inputTokens),
        outputTokens: count(usage.outputTokens),
        cacheReadTokens: count(usage.cacheReadTokens),
        cacheWriteTokens: count(usage.cacheWriteTokens),
      }
      if (position < inherited) inheritedItems.push(row)
      else items.push(row)
    }
  }
  return { items, inheritedItems, route, lastSeq: events.at(-1)?.seq ?? 0 }
}

/**
 * Continue an earlier read of one Session's log.
 *
 * A Session log only appends, so the rows already parsed stay valid and only
 * the tail is read. The prefix is reused only when it demonstrably still
 * describes the same log: the same fork cut, an event count that did not
 * shrink, and the same event at the previous cut (its `seq` is the guard — a
 * rewritten or migrated artifact fails it and restarts from event 0).
 * @param {readonly object[]} events - the Session's complete current log.
 * @param {{inherited?: number, previous?: object|null}} [options] - fork cut and the earlier read, if any.
 * @returns {{items:object[],inheritedItems:object[],route:{provider:string,model:string}|null,lastSeq:number,parsed:number,inherited:number,reused:boolean}} merged rows, the route in force, and whether anything was parsed.
 */
export function scanSessionLog(events, options = {}) {
  const inherited = Number.isInteger(options.inherited) && options.inherited > 0 ? options.inherited : 0
  const previous = options.previous ?? null
  const continues = previous !== null
    && Number.isInteger(previous.parsed)
    && previous.parsed <= events.length
    && (previous.inherited ?? 0) === inherited
    && (previous.parsed === 0 || previous.lastSeq === events[previous.parsed - 1]?.seq)
  if (!continues) {
    const read = scanUsage(events, { inherited })
    return { ...read, parsed: events.length, inherited, reused: false }
  }
  if (previous.parsed === events.length) {
    return {
      items: previous.items,
      inheritedItems: previous.inheritedItems,
      route: previous.route ?? null,
      lastSeq: previous.lastSeq,
      parsed: previous.parsed,
      inherited,
      reused: true,
    }
  }
  const read = scanUsage(events, { from: previous.parsed, inherited, route: previous.route ?? null })
  return {
    items: [...previous.items, ...read.items],
    inheritedItems: [...previous.inheritedItems, ...read.inheritedItems],
    route: read.route,
    lastSeq: read.lastSeq,
    parsed: events.length,
    inherited,
    reused: false,
  }
}
