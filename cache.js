/**
 * Versioned on-disk format for one Session's parsed usage rows.
 *
 * The global report is a fold over every logged model call, so a cold start
 * used to decompress and parse every Session log again. This format stores the
 * rows a Session's log yields — the token counts plus the cost and tariff phase
 * they were last priced at — so a later run reads one small file instead of the
 * full log.
 *
 * Two independent version fields:
 * - `version` is the file layout. A file whose version this build does not know
 *   is ignored and rebuilt; the rows are not interpreted.
 * - `PRICING_VERSION` is folded into `pricing` together with the cost map and
 *   mapping rules. A mismatch means the token counts stay valid but the stored
 *   `cost`/`phase` values must be recomputed.
 *
 * The caller supplies the change token (`revision`): rows describe the log only
 * at that revision, so a file is reused only when the revision still matches.
 *
 * @module dsh-model-cost/cache
 */

/** File layout version. Bump whenever the fields below change incompatibly. */
export const CACHE_VERSION = 1

/**
 * Pricing-semantics generation. Bump when `pricing.js` changes what a call
 * costs or which entry it resolves to, so that every stored cost is recomputed
 * rather than trusted.
 */
export const PRICING_VERSION = 1

const PHASES = new Set(['peak', 'offpeak', 'flat'])

/**
 * Whether a value is a finite non-negative number.
 * @param {unknown} value - candidate.
 * @returns {boolean} true for a usable token count or cost.
 */
function isAmount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * Encode one usage row as a positional array: stable, small, and cheap to
 * validate. Positions: time, provider, model, input, output, cache read, cache
 * write, cost, phase.
 * @param {object} item - parsed and priced usage row.
 * @returns {(string|number|null)[]} encoded row.
 */
export function encodeRow(item) {
  return [
    item.time,
    item.provider,
    item.model,
    item.inputTokens,
    item.outputTokens,
    item.cacheReadTokens,
    item.cacheWriteTokens,
    item.cost,
    item.phase,
  ]
}

/**
 * Decode one positional row, or reject it when any field is unusable. A row
 * always carries the pricing it was written at; `priced` lets the caller decide
 * whether that price still applies without inspecting costs numerically.
 * @param {unknown} raw - decoded array from the cache file.
 * @param {string} priced - pricing signature the file was written at.
 * @returns {object|null} usage row, or null for a malformed row.
 */
export function decodeRow(raw, priced) {
  if (!Array.isArray(raw) || raw.length !== 9) return null
  const [time, provider, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cost, phase] = raw
  if (!isAmount(time) || !isAmount(inputTokens) || !isAmount(outputTokens)) return null
  if (!isAmount(cacheReadTokens) || !isAmount(cacheWriteTokens) || !isAmount(cost)) return null
  if (provider !== null && typeof provider !== 'string') return null
  if (model !== null && typeof model !== 'string') return null
  if (typeof phase !== 'string' || !PHASES.has(phase)) return null
  return { time, provider, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cost, phase, priced }
}

/**
 * Encode one complete cache file.
 * @param {{sessionId:string,revision:string,parsed:number,inherited:number,lastSeq:number,route:object|null,pricing:string,items:object[],inheritedItems:object[]}} scan - parsed Session state.
 * @returns {object} JSON-serializable entry.
 */
export function encodeEntry(scan) {
  return {
    version: CACHE_VERSION,
    sessionId: scan.sessionId,
    revision: scan.revision,
    parsed: scan.parsed,
    inherited: scan.inherited,
    lastSeq: scan.lastSeq,
    route: scan.route === null
      ? null
      : { provider: scan.route.provider ?? null, model: scan.route.model ?? null },
    pricing: scan.pricing,
    writtenAt: Date.now(),
    rows: scan.items.map(encodeRow),
    inheritedRows: scan.inheritedItems.map(encodeRow),
  }
}

/**
 * Decode and validate one cache file.
 *
 * Every failure — unknown layout version, malformed field, one bad row — reads
 * as "no cache", because a cache is an optimization and the log is the source
 * of truth.
 * @param {unknown} raw - parsed JSON from the cache file.
 * @returns {{sessionId:string,revision:string,pricing:string,parsed:number,inherited:number,lastSeq:number,route:object|null,items:object[],inheritedItems:object[],writtenAt:number|null}|null} decoded entry, or null.
 */
export function decodeEntry(raw) {
  if (typeof raw !== 'object' || raw === null) return null
  if (raw.version !== CACHE_VERSION) return null
  if (typeof raw.sessionId !== 'string' || raw.sessionId === '') return null
  if (typeof raw.revision !== 'string' || raw.revision === '') return null
  if (typeof raw.pricing !== 'string' || raw.pricing === '') return null
  if (!Number.isInteger(raw.parsed) || raw.parsed < 0) return null
  if (!Number.isInteger(raw.inherited) || raw.inherited < 0) return null
  if (!Number.isInteger(raw.lastSeq) || raw.lastSeq < 0) return null
  if (!Array.isArray(raw.rows)) return null
  const inheritedRows = raw.inheritedRows === undefined ? [] : raw.inheritedRows
  if (!Array.isArray(inheritedRows)) return null

  let route = null
  if (raw.route !== null && raw.route !== undefined) {
    if (typeof raw.route !== 'object') return null
    const provider = raw.route.provider ?? null
    const model = raw.route.model ?? null
    if (provider !== null && typeof provider !== 'string') return null
    if (model !== null && typeof model !== 'string') return null
    route = { provider, model }
  }

  const items = []
  for (const row of raw.rows) {
    const decoded = decodeRow(row, raw.pricing)
    if (decoded === null) return null
    items.push(decoded)
  }
  const inheritedItems = []
  for (const row of inheritedRows) {
    const decoded = decodeRow(row, raw.pricing)
    if (decoded === null) return null
    inheritedItems.push(decoded)
  }
  return {
    sessionId: raw.sessionId,
    revision: raw.revision,
    pricing: raw.pricing,
    parsed: raw.parsed,
    inherited: raw.inherited,
    lastSeq: raw.lastSeq,
    route,
    items,
    inheritedItems,
    writtenAt: Number.isFinite(raw.writtenAt) ? raw.writtenAt : null,
  }
}
