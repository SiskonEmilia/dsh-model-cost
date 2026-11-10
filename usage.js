/**
 * Session-log reading for cost accounting.
 *
 * The cost map prices calls from `assistant/message` usage, and the route a call
 * billed under comes from the nearest preceding `request/header` or
 * `request/context`. A forked Session's log starts with a copy of its parent's
 * events, so the reader must skip that inherited prefix: those calls were billed
 * once, under the parent.
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
