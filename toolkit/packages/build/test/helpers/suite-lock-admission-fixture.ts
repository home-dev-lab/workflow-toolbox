import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Queue/CLI contract tests exercise real reservation clients and watchdogs, but
// their admission must not depend on unrelated work or free memory on the host.
// Only the machine sensor is replaced, inside a private copy of the plugin.
export function suiteAdmissionFixture(source: string) {
  const plugin = mkdtempSync(join(tmpdir(), 'suite-admission-fixture-'))
  try {
    cpSync(join(source, 'bin'), join(plugin, 'bin'), { recursive: true })
    mkdirSync(join(plugin, '.claude-plugin'))
    cpSync(join(source, '.claude-plugin/plugin.json'), join(plugin, '.claude-plugin/plugin.json'))
    cpSync(join(source, 'CHANGELOG.md'), join(plugin, 'CHANGELOG.md'))
    const original = pathToFileURL(join(source, 'bin/lib/host/suite-lock-machine.mjs')).href
    writeFileSync(join(plugin, 'bin/lib/host/suite-lock-machine.mjs'),
      `export { reservationHostSupported } from ${JSON.stringify(original)};
export const readSuiteMachine = () => ({ cores: 4, memMiB: 4096, load: 0, loadLimit: 4, availableMiB: 8192, floorMiB: 1024 });
`)
    return { plugin, close: () => rmSync(plugin, { recursive: true, force: true }) }
  } catch (error) {
    rmSync(plugin, { recursive: true, force: true })
    throw error
  }
}
