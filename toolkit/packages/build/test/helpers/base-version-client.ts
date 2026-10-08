import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../../..', import.meta.url))
const DESCRIPTOR = 'toolkit/test-support/base-version-client.json'
type ClientRole = 'preLevels' | 'preRelease'
const BASE_CLIENT = JSON.parse(readFileSync(join(ROOT, DESCRIPTOR), 'utf8')) as { clients: Record<ClientRole, string>, paths: string[] }

/** Unpack a descriptor role; CI requires its history, local tests must skip with the returned reason. */
export async function baseSuiteLock(root: string, role: ClientRole, onCi = /^(1|true)$/i.test(process.env.CI ?? '')) {
  const commit = BASE_CLIENT.clients[role]
  const archive = spawnSync('git', ['archive', commit, ...BASE_CLIENT.paths], { cwd: ROOT, maxBuffer: 10 * 1024 * 1024 })
  const unpack = archive.status === 0 ? spawnSync('tar', ['-x', '-C', root], { input: archive.stdout }) : null
  if (!unpack || unpack.status !== 0) {
    const failed = unpack ?? archive
    const reason = `${DESCRIPTOR}: ${role} client ${commit} unavailable in this clone: ${String(failed.error?.message ?? failed.stderr).trim()}`
    if (onCi) throw new Error(`${reason}; the cross-OS workflow must fetch every descriptor client`)
    return { unavailable: reason }
  }
  mkdirSync(join(root, 'plugin/.claude-plugin'))
  writeFileSync(join(root, 'plugin/.claude-plugin/plugin.json'), readFileSync(join(ROOT, 'plugin/.claude-plugin/plugin.json')))
  return { client: await import(pathToFileURL(join(root, 'plugin/bin/lib/suite-lock.mjs')).href) }
}
