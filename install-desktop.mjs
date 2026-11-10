/**
 * Install this plugin into the Desktop profile through the Desktop's own CLI.
 *
 * Run it through install-desktop.ps1: the script needs Desktop's Electron Node
 * runtime (ELECTRON_RUN_AS_NODE=1) and the bundled pnpm, which is how
 * `dsh plugin --profile desktop add` resolves the profile's node_modules.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageDir = dirname(fileURLToPath(import.meta.url))
const resources = join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources')
const cli = join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const pnpmCandidates = [
  join(resources, 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'),
  join(resources, 'runtime', 'pnpm', 'bin', 'pnpm.mjs'),
]
const pnpm = pnpmCandidates.find(candidate => existsSync(candidate))
if (!existsSync(cli) || pnpm === undefined) {
  throw new Error("Run install-desktop.ps1 with Desktop's own Electron Node runtime.")
}
const { runCli } = await import(pathToFileURL(cli).href)
process.argv = [process.execPath, process.argv[1], 'plugin', '--profile', 'desktop', 'add', packageDir, '--config.auto-install-peers=false']
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
