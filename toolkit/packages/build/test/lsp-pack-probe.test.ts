import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  availableVerdict,
  buildShimDirectory,
  linkWorkspaceModules,
  missingVerdict,
  resolveCommand,
} from '../../../scripts/lsp-pack-probe.mjs'

const temporaryDirectories: string[] = []

function temporary(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

function executable(directory: string, name: string) {
  const file = join(directory, name)
  writeFileSync(file, '#!/bin/sh\nexit 0\n')
  chmodSync(file, 0o755)
  return file
}

function streamEvent(type: 'assistant' | 'user', content: string) {
  const messageContent = type === 'user' ? [{ type: 'tool_result', content }] : [{ type: 'text', text: content }]
  return JSON.stringify({ type, message: { content: messageContent } })
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('LSP pack probe pure contracts', () => {
  it('builds one PATH shim that preserves executables while excluding only the declared command', () => {
    const first = temporary('wt-lsp-path-a-')
    const second = temporary('wt-lsp-path-b-')
    const shim = temporary('wt-lsp-shim-')
    executable(first, 'node')
    executable(first, 'language-server')
    executable(second, 'claude')
    executable(second, 'language-server')

    buildShimDirectory([first, second].join(delimiter), 'language-server', shim)

    expect(resolveCommand('node', shim)).toBe(join(shim, 'node'))
    expect(resolveCommand('claude', shim)).toBe(join(shim, 'claude'))
    expect(resolveCommand('language-server', shim)).toBeUndefined()
  })

  it('passes the available arm only for a resolved command, a harness-delivered diagnostic naming the planted error, and normal exit', () => {
    const delivered = "[DEBUG] [LSP PROTOCOL x] Received notification 'textDocument/publishDiagnostics'.\n[DEBUG] LSP Diagnostics: Returning 1 diagnostic attachment(s)\n"
    const passing = { commandResolved: '/bin/server', output: streamEvent('assistant', '<new-diagnostics> TS2554'), debug: delivered, expectedSubstring: 'TS2554', exitCode: 0, timedOut: false }
    expect(availableVerdict(passing).pass).toBe(true)
    expect(availableVerdict({ ...passing, output: streamEvent('user', '<new-diagnostics> TS2554') }).pass).toBe(true)
    expect(availableVerdict({ ...passing, commandResolved: undefined }).pass).toBe(false)
    // the model's prose alone is not delivery: without the harness record the arm fails
    expect(availableVerdict({ ...passing, debug: '' }).pass).toBe(false)
    expect(availableVerdict({ ...passing, debug: "[DEBUG] LSP Diagnostics: Returning 0 diagnostic attachment(s)\n" }).pass).toBe(false)
    // delivery of some other diagnostic is not the planted one
    expect(availableVerdict({ ...passing, output: streamEvent('assistant', '<new-diagnostics> TS9999') }).pass).toBe(false)
    expect(availableVerdict({ ...passing, exitCode: 1 }).pass).toBe(false)
  })

  it('passes the missing arm only when isolation holds, no diagnostic arrives, and the session exits normally', () => {
    const passing = { commandResolved: undefined, claudeResolved: '/shim/claude', nodeResolved: '/shim/node', output: 'no diagnostics', exitCode: 0, timedOut: false }
    expect(missingVerdict(passing).pass).toBe(true)
    expect(missingVerdict({ ...passing, commandResolved: '/shim/server' }).pass).toBe(false)
    expect(missingVerdict({ ...passing, nodeResolved: undefined }).pass).toBe(false)
    expect(missingVerdict({ ...passing, output: streamEvent('user', '<new-diagnostics> TS2554') }).pass).toBe(false)
    expect(missingVerdict({ ...passing, output: streamEvent('assistant', 'no <new-diagnostics> arrived') }).pass).toBe(true)
    expect(missingVerdict({ ...passing, debug: "[DEBUG] LSP Diagnostics: Returning 1 diagnostic attachment(s)\n" }).pass).toBe(false)
    expect(missingVerdict({ ...passing, debug: "[DEBUG] [LSP PROTOCOL x] Received notification 'textDocument/publishDiagnostics'.\n" }).pass).toBe(false)
    expect(missingVerdict({ ...passing, timedOut: true }).pass).toBe(false)
  })
})

describe('LSP pack probe workspace modules', () => {
  it('symlinks each manifest module from the toolkit into the project and drops the manifest', () => {
    const toolkit = temporary('wt-lsp-toolkit-')
    mkdirSync(join(toolkit, 'node_modules', 'typescript'), { recursive: true })
    const project = temporary('wt-lsp-project-')
    writeFileSync(join(project, 'workspace-modules.txt'), 'typescript\n\n')

    expect(linkWorkspaceModules(project, toolkit)).toEqual(['typescript'])
    expect(lstatSync(join(project, 'node_modules', 'typescript')).isSymbolicLink()).toBe(true)
    expect(existsSync(join(project, 'workspace-modules.txt'))).toBe(false)
  })

  it('does nothing without a manifest and refuses a module the toolkit does not hold', () => {
    const toolkit = temporary('wt-lsp-toolkit-')
    const project = temporary('wt-lsp-project-')
    expect(linkWorkspaceModules(project, toolkit)).toEqual([])
    expect(existsSync(join(project, 'node_modules'))).toBe(false)

    writeFileSync(join(project, 'workspace-modules.txt'), 'not-installed-here\n')
    expect(() => linkWorkspaceModules(project, toolkit)).toThrow(/workspace module not installed in the toolkit: not-installed-here/)
  })
})
