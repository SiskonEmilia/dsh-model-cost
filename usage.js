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
 * Positions at or after `from` are read; positions before `inheritedEventCount`
 * still update the route but contribute no call, because a fork copies its
 * parent's prefix into this log. Pass `route` when continuing an earlier read.
 * @param {readonly object[]} events - the Session's raw log, inherited prefix included.
 * @param {{from?: number, inherited?: number, route?: {provider:string,model:string}|null}} [options] - read window and starting route.
 * @returns {{items: object[], route: {provider:string,model:string}|null, lastSeq: number}} usage rows, the route now in force, and the log's last seq.
 */
export function scanUsage(events, options = {}) {
  const from = Number.isInteger(options.from) && options.from > 0 ? options.from : 0
  const inherited = Number.isInteger(options.inherited) && options.inherited > 0 ? options.inherited : 0
  const items = []
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
      if (position < inherited) continue
      const usage = event.data?.usage
      if (typeof usage !== 'object' || usage === null) continue
      items.push({
        seq: event.seq,
        time: event.time,
        provider: route?.provider ?? null,
        model: route?.model ?? null,
        inputTokens: count(usage.inputTokens),
        outputTokens: count(usage.outputTokens),
        cacheReadTokens: count(usage.cacheReadTokens),
        cacheWriteTokens: count(usage.cacheWriteTokens),
      })
    }
  }
  return { items, route, lastSeq: events.at(-1)?.seq ?? 0 }
}
