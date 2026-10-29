import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Model the Function Hook loader: plugin-owned ESM imports, URL metadata and
// capabilities, with no process, require, Buffer, or Node-module imports in the sandbox.
const LOADER = String.raw`
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const context = vm.createContext({ URL });
const modules = new Map();
async function load(url) {
  if (!url.startsWith('file:')) throw new Error('sandbox import forbidden: ' + url);
  if (modules.has(url)) return modules.get(url);
  const module = new vm.SourceTextModule(readFileSync(new URL(url), 'utf8'), {
    context, identifier: url, initializeImportMeta: meta => { meta.url = url; },
  });
  modules.set(url, module);
  await module.link((specifier, parent) => load(new URL(specifier, parent.identifier).href));
  return module;
}
const module = await load(process.argv[1]);
await module.evaluate();
const commands = [];
const snapshot = await module.namespace.readSnapshot({ process: {
  run: async ([command, ...args], options) => {
    commands.push([command, ...args]);
    const result = spawnSync(command === 'node' ? process.execPath : command, args, {
      encoding: 'utf8', timeout: options.timeoutMs, maxBuffer: 16 * 1024 * 1024,
    });
    return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
  },
} }, JSON.parse(process.argv[2]));
process.stdout.write(JSON.stringify({ snapshot, commands, globals: vm.runInContext('[typeof process, typeof require, typeof Buffer]', context) }));
`

// Builds a synthetic procfs tree, runs the hooks module through the loader model and returns its output.
// The collector's executable lookup reads PATH; pinning it (as what-is-running.test.ts does) keeps the
// scan result independent of the host's PATH, where a failed lookup degrades discovery to partial.
function runLoader(platform: string) {
  const root = mkdtempSync(join(tmpdir(), 'wt-procfs-hook-loader-'))
  const config = { suiteRoot: join(root, 'suite'), configDir: join(root, 'config'), livenessDir: join(root, 'liveness'), procRoot: join(root, 'proc'), platform, executablePlatform: 'linux', processEnv: { PATH: '/missing' }, clockTicks: 100 }
  try {
    mkdirSync(join(config.suiteRoot, 'worktrees'), { recursive: true })
    mkdirSync(join(config.configDir, 'plugins', 'store'), { recursive: true })
    mkdirSync(join(config.configDir, 'plugins', 'data'), { recursive: true })
    mkdirSync(config.livenessDir)
    mkdirSync(join(config.procRoot, '42'), { recursive: true })
    writeFileSync(join(config.procRoot, 'uptime'), '123.00 1.00\n')
    writeFileSync(join(config.procRoot, '42', 'cmdline'), 'node\0worker\0')
    writeFileSync(join(config.procRoot, '42', 'status'), 'Name:\tworker\nPPid:\t1\n')
    const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', LOADER,
      new URL('../../../../plugin/hooks/hooks.js', import.meta.url).href, JSON.stringify(config)], { encoding: 'utf8', timeout: 30_000 })
    expect(result.status, result.stderr).toBe(0)
    return JSON.parse(result.stdout)
  } finally { rmSync(root, { recursive: true, force: true }) }
}

describe('procfs Function Hook runtime boundary', () => {
  it('loads without Node globals and imports procfs only in the collector subprocess', () => {
    const output = runLoader('linux')
    expect(output.globals).toEqual(['undefined', 'undefined', 'undefined'])
    expect(output.commands[0][2], 'collector subprocess imports the host procfs module').toContain('host/procfs.mjs')
    const availability = output.snapshot.collectors.processes.availability
    expect(availability.status, JSON.stringify(availability)).toBe('available')
    expect(output.snapshot.discovery).not.toBe('unknown')
  })

  it('reports process discovery as unavailable, never partial, when the collector runs on Windows', () => {
    const output = runLoader('win32')
    expect(output.snapshot.collectors.processes.availability).toEqual({ status: 'unknown', reason: 'unavailable on this platform' })
  })
})
