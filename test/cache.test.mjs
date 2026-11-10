// On-disk row cache format: round-trip fidelity and the validation that makes a
// damaged or foreign file read as a miss instead of as data.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CACHE_VERSION, PRICING_VERSION, decodeEntry, decodeRow, encodeEntry } from '../cache.js'

const row = (overrides = {}) => ({
  time: 1_790_000_000_000,
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  inputTokens: 1_000,
  outputTokens: 20,
  cacheReadTokens: 100,
  cacheWriteTokens: 5,
  cost: 0.000321,
  phase: 'offpeak',
  ...overrides,
})

const entry = (overrides = {}) => ({
  sessionId: 'session-abc',
  revision: 'r1',
  parsed: 7,
  inherited: 2,
  lastSeq: 6,
  route: { provider: 'deepseek', model: 'deepseek-v4-flash' },
  pricing: 'p1:map:rules',
  items: [row()],
  inheritedItems: [row({ phase: 'peak' })],
  ...overrides,
})

describe('cache row encoding', () => {
  it('round-trips one row', () => {
    const encoded = encodeEntry(entry())
    const decoded = decodeEntry(JSON.parse(JSON.stringify(encoded)))
    assert.equal(decoded.rows, undefined)
    assert.deepEqual(decoded.items[0], { ...row(), priced: 'p1:map:rules' })
    assert.deepEqual(decoded.inheritedItems[0], { ...row({ phase: 'peak' }), priced: 'p1:map:rules' })
  })

  it('keeps null routes and provider-less rows', () => {
    const decoded = decodeEntry(JSON.parse(JSON.stringify(encodeEntry(entry({
      route: null,
      items: [row({ provider: null, model: null })],
    })))))
    assert.equal(decoded.route, null)
    assert.equal(decoded.items[0].provider, null)
  })

  it('stamps every decoded row with the pricing it was written at', () => {
    const decoded = decodeEntry(JSON.parse(JSON.stringify(encodeEntry(entry({ pricing: 'p1:other:rules' })))))
    assert.equal(decoded.items[0].priced, 'p1:other:rules')
  })

  it('rejects a row whose phase is unknown', () => {
    assert.equal(decodeRow([0, 'p', 'm', 1, 1, 1, 1, 0.5, 'twilight'], 'sig'), null)
  })

  it('rejects a row with negative or non-numeric amounts', () => {
    for (const bad of [
      [Number.NaN, 'p', 'm', 1, 1, 1, 1, 0.5, 'flat'],
      [0, 'p', 'm', -1, 1, 1, 1, 0.5, 'flat'],
      [0, 'p', 'm', 1, 1, 1, 1, null, 'flat'],
    ]) {
      assert.equal(decodeRow(bad, 'sig'), null)
    }
  })
})

describe('cache entry validation', () => {
  it('refuses a foreign format version', () => {
    assert.equal(decodeEntry({ ...entry(), version: CACHE_VERSION + 1 }), null)
    assert.equal(decodeEntry({ ...entry(), version: undefined }), null)
  })

  it('refuses missing identity fields', () => {
    for (const bad of [
      { ...entry(), sessionId: '' },
      { ...entry(), revision: '' },
      { ...entry(), pricing: '' },
      { ...entry(), parsed: -1 },
      { ...entry(), inherited: 1.5 },
      { ...entry(), lastSeq: 'x' },
    ]) {
      assert.equal(decodeEntry({ ...entry(), version: CACHE_VERSION, rows: [], inheritedRows: [], ...bad }), null)
    }
  })

  it('refuses one damaged row in an otherwise valid file', () => {
    const encoded = encodeEntry(entry())
    encoded.rows = [...encoded.rows, ['broken']]
    assert.equal(decodeEntry(encoded), null)
  })

  it('treats a missing inheritedRows list as empty', () => {
    const encoded = encodeEntry(entry())
    delete encoded.inheritedRows
    const decoded = decodeEntry(encoded)
    assert.notEqual(decoded, null)
    assert.deepEqual(decoded.inheritedItems, [])
  })

  it('keeps a missing writtenAt as null', () => {
    const encoded = encodeEntry(entry())
    delete encoded.writtenAt
    assert.equal(decodeEntry(encoded).writtenAt, null)
  })

  it('publishes a pricing generation with the format version', () => {
    assert.ok(Number.isInteger(PRICING_VERSION) && PRICING_VERSION > 0)
    assert.ok(Number.isInteger(CACHE_VERSION) && CACHE_VERSION > 0)
  })
})
