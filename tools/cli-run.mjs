/**
 * Run one dsh CLI command under Desktop's Electron Node runtime.
 * Usage: node tools/cli-run.mjs -- <args...>
 */
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const resources = join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources')
const cli = join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const pnpmCandidates = [
  join(resources, 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'),
  join(resources, 'runtime', 'pnpm', 'bin', 'pnpm.mjs'),
]
const pnpm = pnpmCandidates.find(candidate => existsSync(candidate))
if (!existsSync(cli) || pnpm === undefined) throw new Error('Desktop runtime not found')
const { runCli } = await import(pathToFileURL(cli).href)
const args = process.argv.slice(2).filter(argument => argument !== '--')
process.argv = [process.execPath, process.argv[1], ...args]
try {
  await runCli({
    manageDesktopProfile: true,
    packageManager: {
      command: process.execPath,
      args: ['--expose-internals', pnpm],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      timeoutMs: 180000,
      idleTimeoutMs: 180000,
    },
  })
} catch (error) {
  console.error('[cli-run] failed:', error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  process.exitCode = 1
}
