import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
// @ts-expect-error plugin runtime modules are untyped JavaScript.
import { createBudget, walkFiles } from '../../../../plugin/bin/lib/bounded-walk.mjs'
// @ts-expect-error plugin runtime modules are untyped JavaScript.
import { readFrontmatterFile } from '../../../../plugin/bin/lib/frontmatter.mjs'
// @ts-expect-error plugin runtime modules are untyped JavaScript.
import { boundedJson } from '../../../../plugin/bin/lib/host/bounded-json.mjs'
// @ts-expect-error plugin runtime modules are untyped JavaScript.
import { agentHasNoMessagingTool } from '../../../../plugin/bin/lib/subagent-delivery-shape.mjs'
// @ts-expect-error plugin runtime modules are untyped JavaScript.
import { skillIsUnlistedByInit } from '../../../../plugin/bin/lib/sdk-role-profile.mjs'
// @ts-expect-error plugin runtime modules are untyped JavaScript.
import { toolList } from '../../../../plugin/bin/lib/agent-type-tools.mjs'

describe('bounded inspection and conservative consumers', () => {
  it('W1 charges every self-link and stops reading the directory at the entry limit', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-walk-limit-'))
    try {
      for (let i = 0; i < 30; i++) fs.symlinkSync(root, path.join(root, `alias${i}`))
      let reads = 0, stats = 0
      const injected = { ...fs, opendirSync: (dir: string) => {
        const handle = fs.opendirSync(dir)
        return { readSync: () => { reads++; return handle.readSync() }, closeSync: () => handle.closeSync() }
      }, lstatSync: (file: string) => { stats++; return fs.lstatSync(file) } }
      const result = walkFiles([root], { fs: injected, budget: createBudget({ maxEntries: 1 }) })
      expect(result.exhausted).toBe('entries')
      expect(reads).toBeLessThanOrEqual(2)
      expect(stats).toBeLessThanOrEqual(2)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
  it('W2 charges actual bytes even when fstat understates file growth', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-byte-limit-'))
    try {
      const file = path.join(root, 'agent.md')
      fs.writeFileSync(file, '---\nname: pilot\n---\n')
      const reads: number[] = []
      const injected = { ...fs, fstatSync: (fd: number) => ({ ...fs.fstatSync(fd), isFile: () => true, size: 0 }), readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => { reads.push(length); return fs.readSync(fd, buffer, offset, length, position) } }
      const budget = createBudget({ maxBytes: 1 })
      expect(readFrontmatterFile(file, { fs: injected, budget }).reason).toBe('budget')
      expect(reads).toEqual([2])
      const json = path.join(root, 'registry.json')
      fs.writeFileSync(json, '{}')
      // JSON's real size is also greater than the remaining byte allowance.
      expect(() => boundedJson(json, createBudget({ maxBytes: 1 }))).toThrow()
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
  it('M1/M2 and invalid shapes do not assume a messaging tool or listed skill', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-consumer-lock-'))
    try {
      fs.mkdirSync(path.join(root, '.claude/agents'), { recursive: true })
      fs.writeFileSync(path.join(root, '.claude/agents/other.md'), '---\n"name": pilot\ntools: [Read,\n---\n')
      expect(agentHasNoMessagingTool('pilot', root)).toBe(true)
      expect(skillIsUnlistedByInit('---\nname: x\nuser-invocable: false\nmetadata: [oops\n---\n')).toBe(true)
      expect(toolList(['Read', { Write: 'yes' }])).toBeUndefined()
      expect(agentHasNoMessagingTool('../pilot', root)).toBe(false)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
  it('R15 corpus CLI runs and --help exits successfully', () => {
    const repo = path.resolve(import.meta.dirname, '../../../..')
    const script = path.join(repo, 'toolkit/scripts/frontmatter-corpus-diff.mjs')
    expect(execFileSync('node', [script, '--help'], { encoding: 'utf8' })).toContain('usage:')
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-corpus-cli-'))
    try {
      fs.writeFileSync(path.join(root, 'agent.md'), "---\ndescription: it's about: handling cases\n---\n")
      const output = execFileSync('node', [script, '--examples', '0', root], { encoding: 'utf8' })
      expect(JSON.parse(output.split('\n')[0]!)).toMatchObject({ extension: 1, readerOkYamlReject: 0 })
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
})
