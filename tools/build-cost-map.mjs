/**
 * Reduce the LiteLLM model cost map to the fields this plugin prices with.
 *
 * The upstream map is ~3.5 MB because every entry also carries capability
 * flags, context limits, and deprecation metadata. Pricing needs eight fields
 * plus the offline-window block, so the shipped snapshot keeps exactly those
 * and drops the rest.
 *
 * Usage: node tools/build-cost-map.mjs [source.json] [--out data/cost-map.json]
 * Without a source path the script downloads the upstream map.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const UPSTREAM = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

/** Cost-map fields the pricing engine reads; everything else is dropped. */
const KEPT_FIELDS = [
  'input_cost_per_token',
  'output_cost_per_token',
  'cache_read_input_token_cost',
  'cache_creation_input_token_cost',
  'output_cost_per_reasoning_token',
  'input_cost_per_token_cache_hit',
  'litellm_provider',
  'mode',
  'max_input_tokens',
  'max_output_tokens',
  'off_peak_pricing',
  'alias_of',
  'supports_prompt_caching',
  'supports_reasoning',
  'source',
]

/**
 * Keep only pricing-relevant fields of one entry.
 * @param {Record<string, unknown>} entry - one upstream cost-map entry.
 * @returns {Record<string, unknown>} the reduced entry.
 */
function reduceEntry(entry) {
  const reduced = {}
  for (const field of KEPT_FIELDS) {
    if (entry[field] !== undefined) reduced[field] = entry[field]
  }
  return reduced
}

/**
 * Download the upstream map.
 * @returns {Promise<Record<string, Record<string, unknown>>>} parsed map.
 */
async function download() {
  const response = await fetch(UPSTREAM, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`cost map download failed: HTTP ${response.status}`)
  return await response.json()
}

const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
const outPath = outIndex >= 0 ? args[outIndex + 1] : join(PACKAGE_DIR, 'data', 'cost-map.json')
const sourcePath = args.find(arg => !arg.startsWith('--') && arg !== outPath)

const upstream = sourcePath === undefined
  ? await download()
  : JSON.parse(await readFile(sourcePath, 'utf8'))

const entries = {}
let kept = 0
for (const [key, value] of Object.entries(upstream)) {
  if (typeof value !== 'object' || value === null) continue
  const reduced = reduceEntry(value)
  if (Object.keys(reduced).length === 0) continue
  entries[key] = reduced
  kept += 1
}

const payload = {
  source: 'https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json',
  sourceUrl: UPSTREAM,
  generatedAt: new Date().toISOString(),
  entries,
}

await writeFile(outPath, `${JSON.stringify(payload)}\n`, 'utf8')
const { size } = await import('node:fs').then(fs => fs.promises.stat(outPath))
console.log(`wrote ${outPath}`)
console.log(`entries: ${kept}, bytes: ${size}`)
