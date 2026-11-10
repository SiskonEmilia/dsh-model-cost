// Host service behavior: the global report reads each Session log once and then
// answers from the on-disk row cache, replaying only the append tail.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { register } from 'node:module'
import { after, describe, it } from 'node:test'

register('./support/dsh-loader.mjs', import.meta.url)
const { default: ModelCostService } = await import('../index.js')

const NOW = Date.now()
const USAGE = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }

/** One Session log: a pricing route followed by billed assistant messages. */
function eventsFor(calls, route = { provider: 'deepseek', model: 'deepseek-v4-flash' }) {
  const events = [{
    type: 'request/header',
    seq: 0,
    time: NOW - 600_000,
    data: { header: { config: { provider: route.provider, model: route.model } } },
  }]
  for (let index = 0; index < calls; index += 1) {
    events.push({
      type: 'assistant/message',
      seq: index + 1,
      time: NOW - 500_000 + index,
      data: { usage: USAGE },
    })
  }
  return events
}

/** A fake live-preferred corpus plus its persistence metadata. */
class Corpus {
  /**
   * @param {{persistence?: boolean}} [options] - whether a persistence service is mounted.
   */
  constructor(options = {}) {
    this.persistence = options.persistence !== false
    this.sessions = new Map()
    this.live = new Map()
    this.reads = new Map()
  }

  /**
   * Add one stored Session.
   * @param {string} id - Session id.
   * @param {number} calls - billed assistant messages.
   * @param {{inherited?: number, revision?: string, route?: {provider:string,model:string}}} [options] - fork cut, starting revision, and the route every call bills under.
   * @returns {Corpus} this corpus.
   */
  add(id, calls, options = {}) {
    this.sessions.set(id, {
      id,
      events: eventsFor(calls, options.route),
      revision: options.revision ?? 'r1',
      inherited: options.inherited ?? 0,
    })
    return this
  }

  /**
   * Replace one stored Session's log, as a compacted or rewritten artifact would.
   * @param {string} id - Session id.
   * @param {number} calls - billed assistant messages in the new log.
   * @returns {void}
   */
  rewrite(id, calls) {
    const session = this.sessions.get(id)
    session.events = eventsFor(calls)
    session.revision = `${session.revision}-next`
  }

  /**
   * Make one Session live and give it an in-memory log.
   * @param {string} id - Session id.
   * @param {number} calls - billed assistant messages.
   * @param {number} [inherited] - fork-inherited prefix length.
   * @returns {void}
   */
  goLive(id, calls, inherited = 0) {
    const session = {
      id,
      events: eventsFor(calls),
      inherited,
      inheritedEventCount: inherited,
      /** @returns {readonly object[]} the current in-memory log. */
      snapshotEvents() {
        return this.events
      },
    }
    this.live.set(id, session)
    this.sessions.set(id, { id, events: [], revision: `memory:${id}:1`, inherited })
  }

  /**
   * Append one billed call to a live Session.
   * @param {string} id - Session id.
   * @returns {void}
   */
  appendLive(id) {
    const session = this.live.get(id)
    const seq = session.events.length
    session.events.push({ type: 'assistant/message', seq, time: NOW - 1_000 + seq, data: { usage: USAGE } })
  }

  /** Forget how often each log was read. */
  resetReads() {
    this.reads.clear()
  }

  /**
   * @param {string} id - Session id.
   * @returns {number} times this test read that Session's log.
   */
  readsOf(id) {
    return this.reads.get(id) ?? 0
  }

  /**
   * Build a context exposing this corpus through the services the plugin reads.
   * @returns {object} fake context.
   */
  context() {
    const corpus = this
    return {
      effect(register) { return register() },
      get(name) {
        if (name === 'sessions') return { get: id => corpus.live.get(id) }
        if (name === 'sessionQuery') {
          return {
            listSessions: async () => [...corpus.sessions.values()].map(session => ({
              header: { id: session.id, createdAt: NOW - 1_000 },
              live: corpus.live.has(session.id),
              persisted: true,
            })),
            readSession: async id => {
              corpus.reads.set(id, (corpus.reads.get(id) ?? 0) + 1)
              const session = corpus.sessions.get(id)
              if (session === undefined) throw new Error(`unknown session ${id}`)
              return { session: { id }, inheritedEventCount: session.inherited, events: session.events }
            },
          }
        }
        if (name === 'sessionPersistence' && corpus.persistence) {
          return {
            list: async () => [...corpus.sessions.values()].map(session => ({
              header: { id: session.id },
              revision: session.revision,
            })),
            stat: async id => ({ header: { id }, revision: corpus.sessions.get(id).revision }),
          }
        }
        return undefined
      },
      logger: { debug() {}, info() {}, warn() {} },
    }
  }

  /**
   * Construct a fresh Host service over this corpus. A new instance drops the
   * in-memory scans, which is how a process restart is modeled.
   * @returns {object} service.
   */
  service() {
    return new ModelCostService(this.context())
  }
}

const homes = []

/** Point the plugin at an empty harness home for one test. */
function freshHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-model-cost-test-'))
  homes.push(home)
  process.env.DSH_HOME = home
  return home
}

after(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})

/** @param {string} home - harness home. @returns {string[]} cache file names. */
function cacheFiles(home) {
  const dir = join(home, 'model-cost', 'cache')
  return existsSync(dir) ? readdirSync(dir) : []
}

describe('report session cache', () => {
  it('reads every log once, then answers a restart from the row cache', async () => {
    const home = freshHome()
    const corpus = new Corpus().add('a', 3).add('b', 2)
    const first = await corpus.service().report({ range: 'all', dimension: 'model' })
    assert.equal(first.totals.requests, 5)
    assert.equal(first.scanned.read, 2)
    assert.equal(first.scanned.cached, 0)
    assert.equal(corpus.readsOf('a'), 1)
    assert.deepEqual(cacheFiles(home).sort(), ['a.json', 'b.json'])

    corpus.resetReads()
    const restarted = await corpus.service().report({ range: 'all', dimension: 'model' })
    assert.equal(restarted.totals.requests, 5)
    assert.equal(restarted.totals.cost, first.totals.cost)
    assert.equal(restarted.scanned.cached, 2)
    assert.equal(restarted.scanned.read, 0)
    assert.equal(corpus.readsOf('a'), 0)
    assert.equal(corpus.readsOf('b'), 0)
  })

  it('re-reads only the Session whose log appended', async () => {
    freshHome()
    const corpus = new Corpus().add('a', 3).add('b', 2)
    const first = await corpus.service().report({ range: 'all', dimension: 'model' })
    corpus.rewrite('a', 5)
    corpus.resetReads()

    const report = await corpus.service().report({ range: 'all', dimension: 'model' })
    assert.equal(report.totals.requests, 7)
    assert.ok(report.totals.cost > first.totals.cost)
    assert.equal(corpus.readsOf('a'), 1)
    assert.equal(corpus.readsOf('b'), 0)
    assert.equal(report.scanned.cached, 1)
  })

  it('reprices cached rows on a mapping change without opening any log', async () => {
    freshHome()
    const corpus = new Corpus().add('a', 3).add('b', 2)
    await corpus.service().report({ range: 'all', dimension: 'model' })
    corpus.resetReads()

    const service = corpus.service()
    await service.saveMapping([{ provider: 'deepseek', model: 'deepseek-v4-flash', key: 'deepseek/deepseek-v4-pro' }])
    const repriced = await service.report({ range: 'all', dimension: 'model' })
    assert.equal(repriced.totals.requests, 5)
    assert.equal(repriced.scanned.cached, 2)
    assert.equal(corpus.readsOf('a'), 0)
    assert.equal(corpus.readsOf('b'), 0)

    const forced = await corpus.service().report({ range: 'all', dimension: 'model', force: true })
    assert.equal(forced.totals.cost, repriced.totals.cost)
  })

  it('ignores a cache file written by an unknown format version', async () => {
    const home = freshHome()
    const corpus = new Corpus().add('a', 2).add('b', 1)
    await corpus.service().report({ range: 'all', dimension: 'model' })
    for (const name of cacheFiles(home)) {
      const path = join(home, 'model-cost', 'cache', name)
      const entry = JSON.parse(readFileSync(path, 'utf8'))
      entry.version = 99
      writeFileSync(path, JSON.stringify(entry))
    }
    corpus.resetReads()
    const report = await corpus.service().report({ range: 'all', dimension: 'model' })
    assert.equal(report.totals.requests, 3)
    assert.equal(corpus.readsOf('a'), 1)
    assert.equal(corpus.readsOf('b'), 1)
  })

  it('treats a malformed cache file as a miss', async () => {
    const home = freshHome()
    const corpus = new Corpus().add('a', 2).add('b', 1)
    await corpus.service().report({ range: 'all', dimension: 'model' })
    writeFileSync(join(home, 'model-cost', 'cache', 'a.json'), '{ not json')
    corpus.resetReads()
    const report = await corpus.service().report({ range: 'all', dimension: 'model' })
    assert.equal(report.totals.requests, 3)
    assert.equal(corpus.readsOf('a'), 1)
    assert.equal(corpus.readsOf('b'), 0)
  })

  it('restarts a Session whose stored log was rewritten shorter', async () => {
    freshHome()
    const corpus = new Corpus().add('a', 3).add('b', 2)
    await corpus.service().report({ range: 'all', dimension: 'model' })
    corpus.rewrite('a', 1)
    corpus.resetReads()
    const report = await corpus.service().report({ range: 'all', dimension: 'model' })
    assert.equal(report.totals.requests, 3)
    assert.equal(corpus.readsOf('a'), 1)
    assert.equal(corpus.readsOf('b'), 0)
  })

  it('keeps live Sessions out of the cache and follows their appends', async () => {
    const home = freshHome()
    const corpus = new Corpus().add('stored', 2)
    corpus.goLive('live-1', 2)
    const first = await corpus.service().report({ range: 'all', dimension: 'model' })
    assert.equal(first.totals.requests, 4)
    assert.equal(corpus.readsOf('live-1'), 0)
    assert.deepEqual(cacheFiles(home), ['stored.json'])

    corpus.appendLive('live-1')
    corpus.resetReads()
    const second = await corpus.service().report({ range: 'all', dimension: 'model' })
    assert.equal(second.totals.requests, 5)
    assert.equal(corpus.readsOf('live-1'), 0)
    assert.equal(corpus.readsOf('stored'), 0)
  })

  it('still answers when no persistence service reports revisions', async () => {
    const home = freshHome()
    const corpus = new Corpus({ persistence: false }).add('a', 2)
    const first = await corpus.service().report({ range: 'all', dimension: 'model' })
    assert.equal(first.totals.requests, 2)
    corpus.resetReads()
    const second = await corpus.service().report({ range: 'all', dimension: 'model' })
    assert.equal(second.totals.requests, 2)
    assert.equal(corpus.readsOf('a'), 1)
    assert.equal(existsSync(join(home, 'model-cost', 'cache')), false)
  })

  it('keeps fork-inherited calls out of totals but in the Session dialog', async () => {
    freshHome()
    const corpus = new Corpus().add('fork', 3, { inherited: 2 })
    const report = await corpus.service().report({ range: 'all', dimension: 'model' })
    assert.equal(report.totals.requests, 2)
    assert.equal(report.totals.sessionsWithUsage, 1)

    const dialog = await corpus.service().session('fork', 'UTC')
    assert.equal(dialog.totals.requests, 2)
    assert.equal(dialog.inherited.requests, 1)
  })
})

describe('report source filter', () => {
  it('drops an excluded provider from the aggregates but still lists it', async () => {
    freshHome()
    const corpus = new Corpus()
      .add('a', 3)
      .add('b', 2, { route: { provider: 'zai-coding-cn', model: 'glm-5.3' } })
    const service = corpus.service()
    const all = await service.report({ range: 'all', dimension: 'provider' })
    assert.equal(all.totals.requests, 5)
    assert.deepEqual(all.sources.map(source => source.provider).sort(), ['deepseek', 'zai-coding-cn'])
    // Without a filter the per-source tallies are the totals, split by provider.
    assert.equal(all.sources.reduce((sum, source) => sum + source.requests, 0), all.totals.requests)
    assert.ok(Math.abs(all.sources.reduce((sum, source) => sum + source.cost, 0) - all.totals.cost) < 1e-9)

    const hidden = await service.report({ range: 'all', dimension: 'provider', exclude: ['zai-coding-cn'] })
    assert.equal(hidden.totals.requests, 3)
    assert.equal(hidden.totals.sessionsWithUsage, 1)
    assert.deepEqual(hidden.groups.map(group => group.id), ['deepseek'])
    // The switch must be able to show what it is hiding, so the tally is
    // collected before the filter and survives it.
    const zai = hidden.sources.find(source => source.provider === 'zai-coding-cn')
    assert.equal(zai.requests, 2)
    assert.ok(zai.cost > 0)
    // Hiding cost rows must not hide the route that needs a price.
    assert.equal(hidden.routes.length, 2)
    assert.equal(hidden.series.reduce((sum, day) => sum + day.requests, 0), 3)

    corpus.resetReads()
    const restored = await corpus.service().report({ range: 'all', dimension: 'provider' })
    assert.equal(restored.totals.requests, 5)
    assert.equal(corpus.readsOf('a') + corpus.readsOf('b'), 0)
  })
})
