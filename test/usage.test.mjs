// Session-log reading: route tracking, usage extraction, and the fork-inherited
// prefix that must not be billed twice.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { scanUsage } from '../usage.js'

const usage = (inputTokens = 10, outputTokens = 2) => ({ inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 })
const header = (seq, provider, model) => ({ type: 'request/header', seq, time: 1, data: { header: { config: { provider, model } } } })
const context = (seq, provider, model) => ({ type: 'request/context', seq, time: 2, data: { provider, model } })
const call = (seq, tokens = usage()) => ({ type: 'assistant/message', seq, time: 3 + seq, data: { usage: tokens } })

describe('scanUsage', () => {
  it('reads one usage row per assistant message and pricing route', () => {
    const read = scanUsage([header(0, 'gateway', 'deepseek-v4-flash'), call(1)])
    assert.equal(read.items.length, 1)
    assert.deepEqual(read.items[0], {
      seq: 1,
      time: 4,
      provider: 'gateway',
      model: 'deepseek-v4-flash',
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    assert.deepEqual(read.route, { provider: 'gateway', model: 'deepseek-v4-flash' })
    assert.equal(read.lastSeq, 1)
  })

  it('lets request/context override the header route', () => {
    const read = scanUsage([header(0, 'a', 'x'), call(1), context(2, 'b', 'y'), call(3)])
    assert.deepEqual(read.items.map(item => `${item.provider}/${item.model}`), ['a/x', 'b/y'])
  })

  it('splits the fork-inherited prefix out of the own calls but keeps its route in force', () => {
    const events = [header(0, 'gateway', 'deepseek-v4-flash'), call(1), call(2)]
    const read = scanUsage(events, { inherited: 2 })
    assert.equal(read.items.length, 1)
    assert.equal(read.items[0].seq, 2)
    assert.equal(read.items[0].provider, 'gateway')
    assert.equal(read.inheritedItems.length, 1)
    assert.equal(read.inheritedItems[0].seq, 1)
    assert.equal(read.inheritedItems[0].provider, 'gateway')
  })

  it('counts nothing as own when the whole log is inherited', () => {
    const read = scanUsage([header(0, 'gateway', 'm'), call(1)], { inherited: 2 })
    assert.equal(read.items.length, 0)
    assert.equal(read.inheritedItems.length, 1)
    assert.deepEqual(read.route, { provider: 'gateway', model: 'm' })
  })

  it('continues an earlier read without re-reading the prefix', () => {
    const prefix = [header(0, 'gateway', 'm'), call(1)]
    const full = [...prefix, call(2)]
    const first = scanUsage(prefix, { inherited: 2 })
    const second = scanUsage(full, { from: prefix.length, inherited: 2, route: first.route })
    assert.equal(first.items.length, 0)
    assert.equal(first.inheritedItems.length, 1)
    assert.equal(second.items.length, 1)
    assert.equal(second.items[0].seq, 2)
    assert.equal(second.inheritedItems.length, 0)
    assert.equal(second.route.provider, 'gateway')
  })

  it('ignores assistant messages without usage', () => {
    const read = scanUsage([header(0, 'gateway', 'm'), { type: 'assistant/message', seq: 1, time: 2, data: {} }])
    assert.equal(read.items.length, 0)
    assert.equal(read.lastSeq, 1)
  })

  it('answers a null route and empty items for an empty log', () => {
    const read = scanUsage([])
    assert.deepEqual(read.items, [])
    assert.equal(read.route, null)
    assert.equal(read.lastSeq, 0)
  })
})
