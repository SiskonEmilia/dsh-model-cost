/**
 * Model cost Host service.
 *
 * Prices every logged model call against the LiteLLM Model Cost Map
 * (`model_prices_and_context_window.json`), including its `off_peak_pricing`
 * windows, and serves two views: one Session's running cost and a cross-Session
 * report. Each call rides the log: the latest `request/header` names the route,
 * and the `assistant/message` that follows carries the usage.
 *
 * Mapping rules let a deployment whose provider ids differ from cost-map
 * providers — a private gateway, a renamed route — name the cost-map key its
 * models price with. Rules and the optional refreshed map live under
 * `$DSH_HOME/model-cost/`.
 *
 * @module dsh-model-cost
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { Service } from '@deepseek-ai/cordis'
import { RemoteError, bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol'
import {
  count, dailySeries, dayKey, dayTimeline, indexCostMap, perMillion, phaseAt, priceUsage,
  rangeWindow, resolveKey, standardRates,
} from './pricing.js'

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))
const SNAPSHOT_PATH = join(PACKAGE_DIR, 'data', 'cost-map.json')
const COST_MAP_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const REMOTE_METHODS = '@deepseek-ai/dsh-typert-protocol/remote-methods'
const MAX_RULES = 500
const MAX_SESSIONS_SCANNED = 800
const COLD_SCAN_TTL_MS = 10 * 60 * 1000
const SCAN_BATCH = 8

/**
 * Resolve the harness home exactly like the shipped home-paths helper: an
 * explicit `DSH_HOME`, else `~/.dsh`.
 * @returns {string} absolute harness home.
 */
function dshHome() {
  const configured = process.env.DSH_HOME?.trim()
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.dsh')
}

/**
 * Read one count-like field from the wire.
 * @param {unknown} value - candidate.
 * @param {number} fallback - value used when the candidate is absent or not positive.
 * @returns {number} a positive integer.
 */
function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/**
 * Group id of one priced call for the selected dimension.
 * @param {string} dimension - grouping dimension.
 * @param {object} item - parsed usage row.
 * @param {{phase:string}} priced - priced call.
 * @param {{key:string}|null} resolution - route resolution.
 * @param {string} sessionId - owning Session id.
 * @returns {string} group id.
 */
function groupKey(dimension, item, priced, resolution, sessionId) {
  switch (dimension) {
    case 'provider': return item.provider ?? '—'
    case 'session': return sessionId
    case 'day': return dayKey(item.time)
    case 'phase': return priced.phase
    case 'model': return resolution?.key ?? item.model ?? '—'
    default: return item.model ?? '—'
  }
}

/**
 * Add one priced call to a group bucket.
 * @param {Map<string, object>} groups - buckets by group id.
 * @param {string} id - group id.
 * @param {{cost:number,phase:string}} priced - priced call.
 * @param {object} item - parsed usage row.
 * @returns {void}
 */
function accumulate(groups, id, priced, item) {
  let bucket = groups.get(id)
  if (bucket === undefined) {
    bucket = {
      label: id,
      cost: 0, peakCost: 0, offpeakCost: 0, requests: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    }
    groups.set(id, bucket)
  }
  bucket.cost += priced.cost
  if (priced.phase === 'peak') bucket.peakCost += priced.cost
  else if (priced.phase === 'offpeak') bucket.offpeakCost += priced.cost
  bucket.requests += 1
  bucket.inputTokens += item.inputTokens
  bucket.outputTokens += item.outputTokens
  bucket.cacheReadTokens += item.cacheReadTokens
  bucket.cacheWriteTokens += item.cacheWriteTokens
}

/** Remote service: model-cost pricing, statistics, and mapping rules. */
export default class ModelCostService extends Service {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - owning context.
   */
  constructor(ctx) {
    super(ctx, 'modelCost')
    this.typertRemote = bindTypertRemote(this, 'modelCost')
    /** @type {object|null} normalized cost map plus its lookup indexes. */
    this.index = null
    /** @type {{version:number,rules:{provider?:string,model:string,key:string}[],prefs:object}|null} */
    this.config = null
    /** @type {Promise<object>|null} in-flight configuration read. */
    this.configLoading = null
    /** Session id -> parsed usage rows; the log prefix stays valid while a Session only appends. */
    this.scans = new Map()
    ctx.effect(() => () => {
      this.scans.clear()
      this.index = null
      this.config = null
    }, 'model-cost: release caches')
  }

  /**
   * Absolute directory holding the refreshed map and the mapping rules.
   * @returns {string} directory path.
   */
  get dataDir() {
    return join(dshHome(), 'model-cost')
  }

  /**
   * Load the cost map once: the deployment's refreshed copy wins over the
   * shipped snapshot.
   * @returns {Promise<object>} the index.
   */
  async loadIndex() {
    if (this.index !== null) return this.index
    const userPath = join(this.dataDir, 'cost-map.json')
    let payload
    let origin = 'snapshot'
    try {
      payload = JSON.parse(await readFile(userPath, 'utf8'))
      origin = 'user'
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
      payload = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'))
    }
    if (typeof payload?.entries !== 'object' || payload.entries === null) {
      throw new RemoteError('modelCost/map-invalid', 'The cost map carries no entries', {})
    }
    this.index = {
      ...indexCostMap(payload.entries),
      meta: {
        source: payload.source ?? 'LiteLLM model cost map',
        sourceUrl: payload.sourceUrl ?? COST_MAP_URL,
        generatedAt: payload.generatedAt ?? null,
        origin,
      },
    }
    return this.index
  }

  /**
   * Load mapping rules and preferences from disk, defaulting to none.
   * @returns {Promise<object>} the configuration.
   */
  async loadConfig() {
    if (this.config !== null) return this.config
    this.configLoading ??= (async () => {
      try {
        const parsed = JSON.parse(await readFile(join(this.dataDir, 'config.json'), 'utf8'))
        this.config = {
          version: 1,
          rules: Array.isArray(parsed?.rules)
            ? parsed.rules.filter(rule => typeof rule?.model === 'string' && typeof rule?.key === 'string')
            : [],
          prefs: typeof parsed?.prefs === 'object' && parsed.prefs !== null ? parsed.prefs : {},
        }
      } catch (error) {
        if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
        this.config = { version: 1, rules: [], prefs: {} }
      } finally {
        this.configLoading = null
      }
      return this.config
    })()
    return this.configLoading
  }

  /**
   * Persist mapping rules and preferences atomically.
   * @param {object} config - complete configuration to write.
   * @returns {Promise<void>} resolves once the file is in place.
   */
  async writeConfig(config) {
    await mkdir(this.dataDir, { recursive: true })
    const target = join(this.dataDir, 'config.json')
    await writeFile(`${target}.tmp`, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    await rename(`${target}.tmp`, target)
    this.config = config
  }

  /**
   * Resolve the cost-map key one route prices with.
   *
   * Rules win, then an exact key, then a unique model-tail match; an ambiguous
   * tail match still answers, marked so the page can ask for an explicit rule.
   * @param {string|null} provider - route provider.
   * @param {string|null} model - route model id.
   * @returns {{key:string,entry:object,via:string,ambiguous:boolean,candidates?:string[]}|null} resolution.
   */
  resolve(provider, model) {
    if (this.index === null) return null
    return resolveKey(this.index, provider, model, this.config?.rules ?? [])
  }

  /**
   * Read one Session's parsed usage rows, reusing everything already parsed.
   *
   * A live Session's log only appends, so the cached prefix stays valid; a
   * stored Session is re-read once its cache entry expires.
   * @param {string} sessionId - Session id.
   * @param {boolean} force - ignore the stored-Session cache age.
   * @returns {Promise<{at:number,parsed:number,items:object[],route:object|null,lastSeq:number}>} parsed rows.
   */
  async scanSession(sessionId, force = false) {
    const cached = this.scans.get(sessionId)
    const live = this.ctx.get('sessions')?.get?.(sessionId)
    if (live === undefined && cached !== undefined && !force && Date.now() - cached.at < COLD_SCAN_TTL_MS) return cached

    let events
    if (live !== undefined) {
      events = live.snapshotEvents()
    } else {
      const engine = this.ctx.get('sessionQuery')
      if (engine === undefined) {
        throw new RemoteError('modelCost/query-unavailable', 'Session history is unavailable in this deployment', { sessionId })
      }
      events = (await engine.readSession(sessionId)).events
    }

    const reusable = cached !== undefined && cached.parsed <= events.length ? cached : undefined
    if (reusable !== undefined && reusable.parsed === events.length) {
      reusable.at = Date.now()
      return reusable
    }
    let route = reusable?.route ?? null
    const items = reusable === undefined ? [] : [...reusable.items]
    for (let position = reusable?.parsed ?? 0; position < events.length; position += 1) {
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
    const scan = { at: Date.now(), parsed: events.length, items, route, lastSeq: events.at(-1)?.seq ?? 0 }
    this.scans.set(sessionId, scan)
    return scan
  }

  /**
   * Fold parsed rows into priced totals, a per-route split, and the phase the
   * most recent route bills under.
   * @param {object[]} items - parsed usage rows.
   * @param {number|null} now - instant for the current phase, or null to skip it.
   * @param {string} timeZone - viewer's IANA zone, used for today's windows.
   * @returns {{totals:object,models:object[],phase:object|null}} folded facts.
   */
  fold(items, now, timeZone = 'UTC') {
    const totals = {
      cost: 0, requests: 0, pricedRequests: 0, unpricedRequests: 0,
      peakCost: 0, offpeakCost: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    }
    const routes = new Map()
    let last = null
    for (const item of items) {
      const resolution = this.resolve(item.provider, item.model)
      const priced = priceUsage(resolution?.entry ?? null, item, item.time)
      totals.requests += 1
      totals.cost += priced.cost
      totals.inputTokens += item.inputTokens
      totals.outputTokens += item.outputTokens
      totals.cacheReadTokens += item.cacheReadTokens
      totals.cacheWriteTokens += item.cacheWriteTokens
      if (priced.phase === 'peak') totals.peakCost += priced.cost
      else if (priced.phase === 'offpeak') totals.offpeakCost += priced.cost
      if (resolution === null) totals.unpricedRequests += 1
      else totals.pricedRequests += 1

      const routeId = `${item.provider ?? ''}\u0000${item.model ?? ''}`
      let row = routes.get(routeId)
      if (row === undefined) {
        row = {
          provider: item.provider,
          model: item.model,
          key: resolution?.key ?? null,
          via: resolution?.via ?? null,
          ambiguous: resolution?.ambiguous ?? false,
          resolved: resolution !== null,
          requests: 0, cost: 0,
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
          peakCost: 0, offpeakCost: 0,
        }
        routes.set(routeId, row)
      }
      row.requests += 1
      row.cost += priced.cost
      row.inputTokens += item.inputTokens
      row.outputTokens += item.outputTokens
      row.cacheReadTokens += item.cacheReadTokens
      row.cacheWriteTokens += item.cacheWriteTokens
      if (priced.phase === 'peak') row.peakCost += priced.cost
      else if (priced.phase === 'offpeak') row.offpeakCost += priced.cost
      last = item
    }

    let phase = null
    if (now !== null && last !== null) {
      const resolution = this.resolve(last.provider, last.model)
      const current = resolution === null ? null : phaseAt(resolution.entry, now)
      const schedule = resolution?.entry.offPeak ?? null
      phase = {
        provider: last.provider,
        model: last.model,
        key: resolution?.key ?? null,
        via: resolution?.via ?? null,
        state: resolution === null ? 'unresolved' : current.state,
        nextAt: current?.nextAt ?? null,
        nextState: current === null || current.state === 'flat'
          ? null
          : current.state === 'offpeak' ? 'peak' : 'offpeak',
        rates: current === null ? null : perMillion(current.rates),
        standard: resolution === null ? null : perMillion(standardRates(resolution.entry)),
        timeZone,
        timeline: dayTimeline(schedule, now, timeZone),
        hasSchedule: schedule !== null,
        source: typeof resolution?.entry.source === 'string' ? resolution.entry.source : null,
      }
    }
    return {
      totals,
      models: [...routes.values()].sort((left, right) => right.cost - left.cost),
      phase,
    }
  }

  /**
   * One Session's running cost, its per-route split, and the phase its current
   * route bills under.
   * @param {string} sessionId - Session id.
   * @param {string} timeZone - viewer's IANA zone, used to render today's off-peak windows.
   * @returns {Promise<object>} session summary.
   */
  async session(sessionId, timeZone) {
    await this.loadIndex()
    await this.loadConfig()
    const scan = await this.scanSession(String(sessionId))
    const folded = this.fold(scan.items, Date.now(), typeof timeZone === 'string' && timeZone !== '' ? timeZone : 'UTC')
    return {
      sessionId: String(sessionId),
      updatedAt: Date.now(),
      hasUsage: folded.totals.requests > 0,
      totals: folded.totals,
      models: folded.models,
      phase: folded.phase,
      map: this.mapMeta(),
    }
  }

  /**
   * Public cost-map facts for the Client.
   * @returns {{source:string,sourceUrl:string,generatedAt:string|null,origin:string,entries:number}} map metadata.
   */
  mapMeta() {
    const index = this.index
    return {
      source: index?.meta.source ?? '',
      sourceUrl: index?.meta.sourceUrl ?? COST_MAP_URL,
      generatedAt: index?.meta.generatedAt ?? null,
      origin: index?.meta.origin ?? 'snapshot',
      entries: index?.entries.size ?? 0,
    }
  }

  /**
   * Scan every Session in the requested range and group the priced calls.
   * @param {object} query - `range`, `dimension`, `limit`, and an optional `force` rescan.
   * @returns {Promise<object>} report.
   */
  async report(query) {
    const request = query ?? {}
    await this.loadIndex()
    await this.loadConfig()
    const engine = this.ctx.get('sessionQuery')
    if (engine === undefined) {
      throw new RemoteError('modelCost/query-unavailable', 'Session history is unavailable in this deployment', {})
    }
    const range = rangeWindow(typeof request.range === 'string' ? request.range : 'all', Date.now())
    const dimension = typeof request.dimension === 'string' ? request.dimension : 'model'
    const records = await engine.listSessions()
    const capped = records.slice(0, MAX_SESSIONS_SCANNED)
    const scanned = []
    for (let start = 0; start < capped.length; start += SCAN_BATCH) {
      const batch = capped.slice(start, start + SCAN_BATCH)
      const settled = await Promise.all(batch.map(async record => {
        try {
          return { record, scan: await this.scanSession(String(record.header.id), request.force === true) }
        } catch (_unreadable) {
          // One unreadable log must not hide the rest of the corpus.
          return null
        }
      }))
      for (const entry of settled) if (entry !== null) scanned.push(entry)
      await new Promise(resolve => setImmediate(resolve))
    }

    const totals = {
      cost: 0, requests: 0, pricedRequests: 0, unpricedRequests: 0,
      peakCost: 0, offpeakCost: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      sessions: scanned.length, sessionsWithUsage: 0,
    }
    const groups = new Map()
    const routes = new Map()
    const days = new Map()
    const sessions = []

    for (const { record, scan } of scanned) {
      const sessionId = String(record.header.id)
      let sessionCost = 0
      let sessionRequests = 0
      for (const item of scan.items) {
        if (item.time < range.start || item.time > range.end) continue
        const resolution = this.resolve(item.provider, item.model)
        const priced = priceUsage(resolution?.entry ?? null, item, item.time)
        sessionCost += priced.cost
        sessionRequests += 1
        totals.cost += priced.cost
        totals.requests += 1
        totals.inputTokens += item.inputTokens
        totals.outputTokens += item.outputTokens
        totals.cacheReadTokens += item.cacheReadTokens
        totals.cacheWriteTokens += item.cacheWriteTokens
        if (priced.phase === 'peak') totals.peakCost += priced.cost
        else if (priced.phase === 'offpeak') totals.offpeakCost += priced.cost
        if (resolution === null) totals.unpricedRequests += 1
        else totals.pricedRequests += 1

        accumulate(groups, groupKey(dimension, item, priced, resolution, sessionId), priced, item)
        accumulate(days, dayKey(item.time), priced, item)

        const routeId = `${item.provider ?? ''}\u0000${item.model ?? ''}`
        let route = routes.get(routeId)
        if (route === undefined) {
          route = {
            provider: item.provider,
            model: item.model,
            key: resolution?.key ?? null,
            via: resolution?.via ?? null,
            ambiguous: resolution?.ambiguous ?? false,
            resolved: resolution !== null,
            candidates: resolution?.candidates ?? null,
            requests: 0, cost: 0, inputTokens: 0, outputTokens: 0,
          }
          routes.set(routeId, route)
        }
        route.requests += 1
        route.cost += priced.cost
        route.inputTokens += item.inputTokens
        route.outputTokens += item.outputTokens
      }
      if (sessionRequests > 0) {
        totals.sessionsWithUsage += 1
        sessions.push({ id: sessionId, title: null, cost: sessionCost, requests: sessionRequests, createdAt: record.header.createdAt })
      }
    }

    if (dimension === 'session') {
      const top = [...sessions].sort((left, right) => right.cost - left.cost).slice(0, positive(request.limit, 25))
      if (top.length > 0 && typeof engine.readTitleSnapshots === 'function') {
        try {
          const observed = await engine.readTitleSnapshots(top.map(row => row.id))
          const byId = new Map(observed.map(entry => [
            String(entry.sessionId),
            entry.status === 'fulfilled' ? entry.value.title?.title ?? null : null,
          ]))
          for (const row of sessions) row.title = byId.get(row.id) ?? null
        } catch (_titleFailure) {
          // Titles are decoration; the report stands without them.
        }
      }
    }

    const titleOf = new Map(sessions.map(row => [row.id, row.title]))
    const list = [...groups.entries()].map(([id, bucket]) => ({
      id,
      label: dimension === 'session' ? (titleOf.get(id) ?? id.slice(0, 8)) : bucket.label,
      cost: bucket.cost,
      requests: bucket.requests,
      inputTokens: bucket.inputTokens,
      outputTokens: bucket.outputTokens,
      cacheReadTokens: bucket.cacheReadTokens,
      cacheWriteTokens: bucket.cacheWriteTokens,
    }))
    list.sort((left, right) => right.cost - left.cost || right.requests - left.requests)
    const billedInput = totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens
    return {
      generatedAt: Date.now(),
      range,
      dimension,
      map: this.mapMeta(),
      totals: {
        ...totals,
        cacheHitRatio: billedInput === 0 ? null : totals.cacheReadTokens / billedInput,
        costPerRequest: totals.requests === 0 ? 0 : totals.cost / totals.requests,
      },
      groups: list.slice(0, positive(request.limit, 25)),
      series: dailySeries(days, range),
      routes: [...routes.values()].sort((left, right) => right.cost - left.cost || right.requests - left.requests),
      scanned: { sessions: scanned.length, available: records.length, capped: records.length > capped.length },
      rules: this.config.rules,
    }
  }

  /**
   * Search cost-map keys for the mapping editor.
   * @param {object} query - `{ text, limit }`.
   * @returns {Promise<{items:object[],total:number}>} matches, best first.
   */
  async searchKeys(query) {
    const index = await this.loadIndex()
    const request = query ?? {}
    const text = typeof request.text === 'string' ? request.text.trim().toLowerCase() : ''
    const limit = Math.min(positive(request.limit, 30), 200)
    const candidates = text === ''
      ? index.alphabetical
      : index.alphabetical.filter(key => key.toLowerCase().includes(text))
    const tailFirst = text === '' ? candidates : [
      ...candidates.filter(key => key.toLowerCase() === text || key.toLowerCase().endsWith(`/${text}`)),
      ...candidates.filter(key => !(key.toLowerCase() === text || key.toLowerCase().endsWith(`/${text}`))),
    ]
    const items = []
    for (const key of tailFirst) {
      const entry = index.entries.get(key)
      if (entry === undefined || typeof entry.input_cost_per_token !== 'number') continue
      items.push({
        key,
        provider: typeof entry.litellm_provider === 'string' ? entry.litellm_provider : '',
        input: entry.input_cost_per_token,
        output: count(entry.output_cost_per_token),
        offPeak: entry.offPeak !== null,
      })
      if (items.length >= limit) break
    }
    return { items, total: candidates.length }
  }

  /**
   * Replace every mapping rule.
   * @param {unknown} rules - submitted rule list.
   * @returns {Promise<{saved:true,rules:object[]}>} stored rules.
   */
  async saveMapping(rules) {
    const index = await this.loadIndex()
    const config = await this.loadConfig()
    if (!Array.isArray(rules)) {
      throw new RemoteError('modelCost/invalid-rules', 'Mapping rules must be a list', {})
    }
    if (rules.length > MAX_RULES) {
      throw new RemoteError('modelCost/invalid-rules', `At most ${MAX_RULES} mapping rules are supported`, { count: rules.length })
    }
    const seen = new Set()
    const stored = []
    for (const rule of rules) {
      if (typeof rule !== 'object' || rule === null) {
        throw new RemoteError('modelCost/invalid-rules', 'Each mapping rule must be an object', {})
      }
      const model = typeof rule.model === 'string' ? rule.model.trim() : ''
      const key = typeof rule.key === 'string' ? rule.key.trim() : ''
      const provider = typeof rule.provider === 'string' && rule.provider.trim() !== '' ? rule.provider.trim() : undefined
      if (model === '' || key === '') {
        throw new RemoteError('modelCost/invalid-rules', 'Each mapping rule needs a model id and a cost-map key', { model, key })
      }
      if (!index.exact.has(key.toLowerCase())) {
        throw new RemoteError('modelCost/unknown-key', `"${key}" is not a cost-map key`, { key })
      }
      const identity = `${provider?.toLowerCase() ?? ''}\u0000${model.toLowerCase()}`
      if (seen.has(identity)) continue
      seen.add(identity)
      stored.push(provider === undefined ? { model, key } : { provider, model, key })
    }
    await this.writeConfig({ version: 1, rules: stored, prefs: config.prefs })
    return { saved: true, rules: stored }
  }

  /**
   * Download the upstream map and store it as this deployment's map.
   * @returns {Promise<object>} the new map metadata.
   */
  async refreshMap() {
    let payload
    try {
      const response = await fetch(COST_MAP_URL, { signal: AbortSignal.timeout(120_000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      payload = await response.json()
    } catch (error) {
      throw new RemoteError('modelCost/refresh-failed', `Cost map download failed: ${error instanceof Error ? error.message : String(error)}`, {})
    }
    if (typeof payload !== 'object' || payload === null) {
      throw new RemoteError('modelCost/refresh-failed', 'The downloaded cost map is not an object', {})
    }
    const entries = {}
    for (const [key, raw] of Object.entries(payload)) {
      if (typeof raw === 'object' && raw !== null) entries[key] = raw
    }
    const stored = {
      source: 'https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json',
      sourceUrl: COST_MAP_URL,
      generatedAt: new Date().toISOString(),
      entries,
    }
    await mkdir(this.dataDir, { recursive: true })
    const target = join(this.dataDir, 'cost-map.json')
    await writeFile(`${target}.tmp`, `${JSON.stringify(stored)}\n`, 'utf8')
    await rename(`${target}.tmp`, target)
    this.index = null
    this.scans.clear()
    await this.loadIndex()
    return this.mapMeta()
  }
}

// Source-mode Remote markers in the shape the Typert Gateway discovers on
// service prototypes; hand-written because this package ships plain JS.
Object.defineProperty(ModelCostService.prototype, REMOTE_METHODS, {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze([
      Object.freeze({ method: 'session', invocation: Object.freeze({ kind: 'direct' }) }),
      Object.freeze({ method: 'report', invocation: Object.freeze({ kind: 'direct' }) }),
      Object.freeze({ method: 'searchKeys', invocation: Object.freeze({ kind: 'direct' }) }),
      Object.freeze({ method: 'saveMapping', invocation: Object.freeze({ kind: 'direct' }) }),
      Object.freeze({ method: 'refreshMap', invocation: Object.freeze({ kind: 'direct' }) }),
    ]),
  }),
})
