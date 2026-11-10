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
 * A stored Session's parsed rows and prices are cached under
 * `$DSH_HOME/model-cost/cache/` and keyed by the persistence revision they were
 * read at, so a restart re-reads only the logs that changed; a pricing
 * signature keeps a cost-map refresh or a rule edit from re-reading anything.
 *
 * @module dsh-model-cost
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { Service } from '@deepseek-ai/cordis'
import { RemoteError, bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol'
import { PRICING_VERSION, decodeEntry, encodeEntry } from './cache.js'
import {
  count, dailySeries, dayKey, dayTimeline, hourBuckets, indexCostMap, lastDayOf, perMillion, phaseAt, priceUsage,
  rangeWindow, resolveKey, standardRates,
} from './pricing.js'
import { scanSessionLog } from './usage.js'

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))
const SNAPSHOT_PATH = join(PACKAGE_DIR, 'data', 'cost-map.json')
const COST_MAP_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const REMOTE_METHODS = '@deepseek-ai/dsh-typert-protocol/remote-methods'
const MAX_RULES = 500
const MAX_SESSIONS_SCANNED = 800
const COLD_SCAN_TTL_MS = 10 * 60 * 1000
const SCAN_BATCH = 8
/** Rows cached for a Session whose stored log has not appeared in a listing for this long are dropped. */
const CACHE_PRUNE_AGE_MS = 7 * 24 * 60 * 60 * 1000
const CACHE_PRUNE_INTERVAL_MS = 60 * 60 * 1000

/**
 * Digest used for cache change detection. Truncated because it only has to
 * distinguish inputs, never resist an attacker.
 * @param {string} text - input text.
 * @returns {string} 16 hex characters.
 */
function digest(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/**
 * Cache file name for one Session. Ordinary Session ids are already filesystem
 * safe and stay readable; anything else is reversible base64url so a listing can
 * recover the id for pruning.
 * @param {string} sessionId - Session id.
 * @returns {string} file name.
 */
function cacheFileName(sessionId) {
  return /^[A-Za-z0-9._-]{1,96}$/.test(sessionId)
    ? `${sessionId}.json`
    : `~${Buffer.from(sessionId, 'utf8').toString('base64url')}.json`
}

/**
 * Recover the Session id from a cache file name.
 * @param {string} name - file name from the cache directory.
 * @returns {string|null} Session id, or null for an unrelated file.
 */
function cacheFileSessionId(name) {
  if (!name.endsWith('.json')) return null
  const stem = name.slice(0, -'.json'.length)
  if (!stem.startsWith('~')) return stem === '' ? null : stem
  try {
    const id = Buffer.from(stem.slice(1), 'base64url').toString('utf8')
    return id === '' ? null : id
  } catch (_malformedName) {
    return null
  }
}

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
    /** Pricing signature for the loaded map and rules, recomputed when either changes. */
    this.pricingKey = null
    /** Last time the orphaned cache files were pruned. */
    this.prunedAt = 0
    /** Monotonic suffix that keeps concurrent cache writes from sharing a temp file. */
    this.cacheWrites = 0
    ctx.effect(() => () => {
      this.scans.clear()
      this.index = null
      this.config = null
      this.pricingKey = null
      this.prunedAt = 0
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
   * Absolute directory holding one cache file per stored Session.
   * @returns {string} directory path.
   */
  get cacheDir() {
    return join(this.dataDir, 'cache')
  }

  /**
   * Signature of everything a stored price depends on: the pricing engine
   * generation, the cost map contents, and the mapping rules. Usage rows are
   * priced once per signature; a change reprices them without re-reading logs.
   * @returns {string} signature.
   */
  get pricingSignature() {
    if (this.pricingKey === null) {
      const rules = this.config?.rules ?? []
      this.pricingKey = `p${PRICING_VERSION}:${this.index?.fingerprint ?? 'unmapped'}:${digest(JSON.stringify(rules))}`
    }
    return this.pricingKey
  }

  /**
   * Load the cost map once: the deployment's refreshed copy wins over the
   * shipped snapshot.
   * @returns {Promise<object>} the index.
   */
  async loadIndex() {
    if (this.index !== null) return this.index
    const userPath = join(this.dataDir, 'cost-map.json')
    let text
    let origin = 'user'
    try {
      text = await readFile(userPath, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      origin = 'snapshot'
      text = await readFile(SNAPSHOT_PATH, 'utf8')
    }
    let payload
    try {
      payload = JSON.parse(text)
    } catch (error) {
      if (!(error instanceof SyntaxError) || origin === 'snapshot') throw error
      // A malformed refreshed map must not take the shipped snapshot down with it.
      origin = 'snapshot'
      text = await readFile(SNAPSHOT_PATH, 'utf8')
      payload = JSON.parse(text)
    }
    if (typeof payload?.entries !== 'object' || payload.entries === null) {
      throw new RemoteError('modelCost/map-invalid', 'The cost map carries no entries', {})
    }
    this.index = {
      ...indexCostMap(payload.entries),
      fingerprint: digest(text),
      meta: {
        source: payload.source ?? 'LiteLLM model cost map',
        sourceUrl: payload.sourceUrl ?? COST_MAP_URL,
        generatedAt: payload.generatedAt ?? null,
        origin,
      },
    }
    this.pricingKey = null
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
      this.pricingKey = null
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
    this.pricingKey = null
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
   * A live Session's log only appends, so its in-memory prefix stays valid and
   * only the tail is parsed. A stored Session is reused across restarts while
   * the persistence revision it was read at still matches: an unchanged log is
   * answered from the on-disk cache without opening it, a changed one is read
   * again and its entry rebuilt. A forked Session's inherited prefix is kept
   * aside: the parent already bills those calls.
   * @param {string} sessionId - Session id.
   * @param {{force?: boolean, revision?: string|null}} [options] - rescan switch and the stored revision the caller already observed.
   * @returns {Promise<object>} parsed rows with their pricing state and whether this call read the log.
   */
  async scanSession(sessionId, options = {}) {
    const force = options.force === true
    const signature = this.pricingSignature
    const live = this.ctx.get('sessions')?.get?.(sessionId)
    const cached = this.scans.get(sessionId)

    if (live !== undefined) {
      const events = live.snapshotEvents()
      // Fork-inherited prefix length; absent on runtimes that predate forks.
      const inherited = Number.isInteger(live.inheritedEventCount) ? live.inheritedEventCount : 0
      const read = scanSessionLog(events, { inherited, previous: force ? null : cached })
      const scan = {
        at: Date.now(),
        source: 'live',
        revision: null,
        parsed: read.parsed,
        inherited,
        items: read.items,
        inheritedItems: read.inheritedItems,
        route: read.route,
        lastSeq: read.lastSeq,
        read: !read.reused,
      }
      this.scans.set(sessionId, scan)
      this.priceScan(scan, signature)
      return scan
    }

    const revision = typeof options.revision === 'string' && options.revision !== ''
      ? options.revision
      : await this.storedRevision(sessionId)

    if (!force && cached !== undefined) {
      const fresh = revision === undefined
        ? Date.now() - cached.at < COLD_SCAN_TTL_MS
        : cached.revision === revision
      if (fresh) {
        cached.at = Date.now()
        cached.read = false
        if (this.priceScan(cached, signature)) await this.writeCacheEntry(sessionId, cached)
        return cached
      }
    }

    if (!force && revision !== undefined) {
      const entry = await this.readCacheEntry(sessionId, revision)
      if (entry !== null) {
        const scan = {
          at: Date.now(),
          source: 'stored',
          revision: entry.revision,
          parsed: entry.parsed,
          inherited: entry.inherited,
          items: entry.items,
          inheritedItems: entry.inheritedItems,
          route: entry.route,
          lastSeq: entry.lastSeq,
          read: false,
        }
        this.scans.set(sessionId, scan)
        if (this.priceScan(scan, signature)) await this.writeCacheEntry(sessionId, scan)
        return scan
      }
    }

    const engine = this.ctx.get('sessionQuery')
    if (engine === undefined) {
      throw new RemoteError('modelCost/query-unavailable', 'Session history is unavailable in this deployment', { sessionId })
    }
    const snapshot = await engine.readSession(sessionId)
    const inherited = Number.isInteger(snapshot.inheritedEventCount) ? snapshot.inheritedEventCount : 0
    const parsed = scanSessionLog(snapshot.events, { inherited, previous: force ? null : cached })
    const scan = {
      at: Date.now(),
      source: 'stored',
      revision: revision ?? null,
      parsed: parsed.parsed,
      inherited,
      items: parsed.items,
      inheritedItems: parsed.inheritedItems,
      route: parsed.route,
      lastSeq: parsed.lastSeq,
      read: true,
    }
    this.scans.set(sessionId, scan)
    this.priceScan(scan, signature)
    await this.writeCacheEntry(sessionId, scan)
    return scan
  }

  /**
   * Price one usage row if it was last priced under a different signature.
   * @param {object} item - usage row.
   * @param {string} signature - current pricing signature.
   * @returns {void}
   */
  stampItem(item, signature) {
    const resolution = this.resolve(item.provider, item.model)
    const priced = priceUsage(resolution?.entry ?? null, item, item.time)
    item.cost = priced.cost
    item.phase = priced.phase
    item.priced = signature
  }

  /**
   * Bring every row of one Session scan up to the current pricing signature.
   * @param {{items:object[],inheritedItems:object[]}} scan - parsed Session state.
   * @param {string} signature - current pricing signature.
   * @returns {boolean} true when at least one row was priced again.
   */
  priceScan(scan, signature) {
    let changed = false
    for (const item of scan.items) {
      if (item.priced === signature) continue
      this.stampItem(item, signature)
      changed = true
    }
    for (const item of scan.inheritedItems) {
      if (item.priced === signature) continue
      this.stampItem(item, signature)
      changed = true
    }
    return changed
  }

  /**
   * Ensure one row carries the current price, pricing it on a signature change.
   * @param {object} item - usage row.
   * @param {string} signature - current pricing signature.
   * @returns {object} the same row, now with `cost` and `phase`.
   */
  priceRow(item, signature) {
    if (item.priced !== signature) this.stampItem(item, signature)
    return item
  }

  /**
   * Current persistence revision of one stored Session, which changes whenever
   * its log is appended or rewritten.
   * @param {string} sessionId - Session id.
   * @returns {Promise<string|undefined>} revision, or undefined when no backend reports one.
   */
  async storedRevision(sessionId) {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined || typeof persistence.stat !== 'function') return undefined
    try {
      const snapshot = await persistence.stat(sessionId)
      return typeof snapshot?.revision === 'string' && snapshot.revision !== '' ? snapshot.revision : undefined
    } catch (_unreadable) {
      // Without a revision the log is read again; the cache is only an optimization.
      return undefined
    }
  }

  /**
   * Revision of every stored Session, in one listing. A backend that cannot
   * list leaves callers on the full-read path instead of failing the report.
   * @returns {Promise<Map<string,string>|null>} revisions by Session id, or null.
   */
  async revisionMap() {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined || typeof persistence.list !== 'function') return null
    try {
      const snapshots = await persistence.list()
      const map = new Map()
      for (const snapshot of snapshots) {
        const id = snapshot?.header?.id
        const revision = snapshot?.revision
        if (typeof id === 'string' && typeof revision === 'string' && revision !== '') map.set(id, revision)
      }
      return map
    } catch (error) {
      this.ctx.logger?.warn?.(`model-cost: Session revisions unavailable, reading logs instead: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  /**
   * Read one Session's cache file, accepting it only when it describes the log
   * at the revision in hand.
   * @param {string} sessionId - Session id.
   * @param {string} revision - current persistence revision.
   * @returns {Promise<object|null>} decoded entry, or null on a miss.
   */
  async readCacheEntry(sessionId, revision) {
    const path = join(this.cacheDir, cacheFileName(sessionId))
    let text
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') this.ctx.logger?.debug?.(`model-cost: Session cache unreadable at ${path}: ${String(error)}`)
      return null
    }
    let raw
    try {
      raw = JSON.parse(text)
    } catch (_malformed) {
      // A truncated or hand-edited file is a miss; the log is the source of truth.
      return null
    }
    const entry = decodeEntry(raw)
    if (entry === null || entry.sessionId !== sessionId || entry.revision !== revision) return null
    return entry
  }

  /**
   * Replace one Session's cache file atomically, so an interrupted write never
   * leaves a half-readable entry. Failures are contained: the cache is optional.
   * @param {string} sessionId - Session id.
   * @param {object} scan - parsed and priced Session state.
   * @returns {Promise<void>} resolves once the file is in place or the attempt is abandoned.
   */
  async writeCacheEntry(sessionId, scan) {
    const signature = this.pricingSignature
    const revision = scan.revision
    if (typeof revision !== 'string' || revision === '') return
    const priced = scan.items.every(item => item.priced === signature)
      && scan.inheritedItems.every(item => item.priced === signature)
    if (!priced) return
    const body = `${JSON.stringify(encodeEntry({
      sessionId,
      revision,
      parsed: scan.parsed,
      inherited: scan.inherited,
      lastSeq: scan.lastSeq,
      route: scan.route,
      pricing: signature,
      items: scan.items,
      inheritedItems: scan.inheritedItems,
    }))}\n`
    const target = join(this.cacheDir, cacheFileName(sessionId))
    const temp = `${target}.${process.pid}.${++this.cacheWrites}.tmp`
    try {
      await mkdir(this.cacheDir, { recursive: true })
      await writeFile(temp, body, 'utf8')
      await rename(temp, target)
    } catch (error) {
      this.ctx.logger?.debug?.(`model-cost: Session cache write failed for ${sessionId}: ${String(error)}`)
    }
  }

  /**
   * Drop cache files for Sessions the listing no longer reports, plus temp files
   * left by an interrupted write. Throttled to one sweep per hour.
   * @param {Set<string>} seen - Session ids in the current listing.
   * @returns {Promise<void>} resolves once the sweep finishes.
   */
  async pruneCache(seen) {
    const now = Date.now()
    if (now - this.prunedAt < CACHE_PRUNE_INTERVAL_MS) return
    this.prunedAt = now
    let names
    try {
      names = await readdir(this.cacheDir)
    } catch (error) {
      if (error?.code !== 'ENOENT') this.ctx.logger?.debug?.(`model-cost: Session cache sweep skipped: ${String(error)}`)
      return
    }
    for (const name of names) {
      if (name.endsWith('.tmp')) {
        await this.dropCacheFile(join(this.cacheDir, name), now - CACHE_PRUNE_INTERVAL_MS)
        continue
      }
      const id = cacheFileSessionId(name)
      if (id === null || seen.has(id)) continue
      await this.dropCacheFile(join(this.cacheDir, name), now - CACHE_PRUNE_AGE_MS)
    }
  }

  /**
   * Remove one cache file once it is older than a cutoff.
   * @param {string} path - absolute cache file path.
   * @param {number} cutoff - epoch milliseconds; younger files stay.
   * @returns {Promise<void>} resolves whether or not the file was removed.
   */
  async dropCacheFile(path, cutoff) {
    try {
      const info = await stat(path)
      if (info.mtimeMs < cutoff) await unlink(path)
    } catch (_gone) {
      // Already removed or unreadable: nothing left to prune.
    }
  }

  /**
   * Fold parsed rows into priced totals, a per-route split, and the phase the
   * most recent route bills under.
   * @param {object[]} items - parsed usage rows.
   * @param {number|null} now - instant for the current phase, or null to skip it.
   * @param {string} timeZone - viewer's IANA zone, used for today's windows.
   * @param {string} [signature] - pricing signature the rows must carry.
   * @returns {{totals:object,models:object[],phase:object|null}} folded facts.
   */
  fold(items, now, timeZone = 'UTC', signature = this.pricingSignature) {
    const totals = {
      cost: 0, requests: 0, pricedRequests: 0, unpricedRequests: 0,
      peakCost: 0, offpeakCost: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    }
    const routes = new Map()
    let last = null
    for (const item of items) {
      const resolution = this.resolve(item.provider, item.model)
      this.priceRow(item, signature)
      totals.requests += 1
      totals.cost += item.cost
      totals.inputTokens += item.inputTokens
      totals.outputTokens += item.outputTokens
      totals.cacheReadTokens += item.cacheReadTokens
      totals.cacheWriteTokens += item.cacheWriteTokens
      if (item.phase === 'peak') totals.peakCost += item.cost
      else if (item.phase === 'offpeak') totals.offpeakCost += item.cost
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
      row.cost += item.cost
      row.inputTokens += item.inputTokens
      row.outputTokens += item.outputTokens
      row.cacheReadTokens += item.cacheReadTokens
      row.cacheWriteTokens += item.cacheWriteTokens
      if (item.phase === 'peak') row.peakCost += item.cost
      else if (item.phase === 'offpeak') row.offpeakCost += item.cost
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
    const signature = this.pricingSignature
    const scan = await this.scanSession(String(sessionId))
    const zone = typeof timeZone === 'string' && timeZone !== '' ? timeZone : 'UTC'
    const folded = this.fold(scan.items, Date.now(), zone, signature)
    // A fork copies its parent's calls into this log; they are priced for the
    // dialog only, never for the global totals.
    const inherited = scan.inheritedItems.length === 0
      ? null
      : this.fold(scan.inheritedItems, null, zone, signature).totals
    return {
      sessionId: String(sessionId),
      updatedAt: Date.now(),
      hasUsage: folded.totals.requests > 0,
      totals: folded.totals,
      inherited,
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
    const signature = this.pricingSignature
    const engine = this.ctx.get('sessionQuery')
    if (engine === undefined) {
      throw new RemoteError('modelCost/query-unavailable', 'Session history is unavailable in this deployment', {})
    }
    const range = rangeWindow(typeof request.range === 'string' ? request.range : 'all', Date.now())
    const dimension = typeof request.dimension === 'string' ? request.dimension : 'model'
    const records = await engine.listSessions()
    const revisions = await this.revisionMap()
    const capped = records.slice(0, MAX_SESSIONS_SCANNED)
    const scanned = []
    for (let start = 0; start < capped.length; start += SCAN_BATCH) {
      const batch = capped.slice(start, start + SCAN_BATCH)
      const settled = await Promise.all(batch.map(async record => {
        const sessionId = String(record.header.id)
        try {
          return {
            record,
            scan: await this.scanSession(sessionId, {
              force: request.force === true,
              revision: revisions?.get(sessionId),
            }),
          }
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
    /** Every in-range call, priced once: the hourly view reuses these. */
    const calls = []

    for (const { record, scan } of scanned) {
      const sessionId = String(record.header.id)
      let sessionCost = 0
      let sessionRequests = 0
      for (const item of scan.items) {
        if (item.time < range.start || item.time > range.end) continue
        const priced = this.priceRow(item, signature)
        const resolution = this.resolve(item.provider, item.model)
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
        calls.push({
          time: item.time,
          phase: priced.phase,
          cost: priced.cost,
          inputTokens: item.inputTokens,
          outputTokens: item.outputTokens,
          cacheReadTokens: item.cacheReadTokens,
          cacheWriteTokens: item.cacheWriteTokens,
        })

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
    // A one-day range has nothing to spread across dates; the newest day with
    // usage is offered as an hourly timeline instead.
    const newestDay = lastDayOf(days)
    const readNow = scanned.filter(entry => entry.scan.read === true).length
    void this.pruneCache(new Set(records.map(record => String(record.header.id))))
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
      hours: newestDay === null ? null : { date: newestDay, buckets: hourBuckets(calls, newestDay) },
      routes: [...routes.values()].sort((left, right) => right.cost - left.cost || right.requests - left.requests),
      scanned: {
        sessions: scanned.length,
        available: records.length,
        capped: records.length > capped.length,
        cached: scanned.length - readNow,
        read: readNow,
      },
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
