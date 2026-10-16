#!/usr/bin/env node
import { dirname } from 'node:path'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { git, resolveBase, resolveCommit, changedFiles, isCodeSubject, readSubject } from './quality-changed-git.mjs'
import { createLinter, lintText } from './quality-changed-lint.mjs'
import { regressions } from './quality-changed-measure.mjs'

function parseArgs(argv) {
  const options = { base: process.env.WT_QUALITY_BASE, subject: undefined }
  for (let i = 0; i < argv.length; i += 2) {
    const key = { '--base': 'base', '--subject-ref': 'subject' }[argv[i]]
    if (!key || !argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error('usage: quality-changed.mjs [--base <ref>] [--subject-ref <ref>]')
    options[key] = argv[i + 1]
  }
  return options
}
async function compare(eslint, root, base, subject, file, checkerRoot) {
  const text = readSubject(root, subject, file.path)
  const previous = file.added ? '' : git(root, ['show', `${base}:${file.source}`])
  const current = await lintText(eslint, checkerRoot, file.path, text)
  const before = await lintText(eslint, checkerRoot, file.path, previous)
  return [...current.fatal, ...regressions(file.path, current.rules, before.rules, current.functions, before.functions)]
}
export async function runCli(argv) {
  try {
    const options = parseArgs(argv)
    const checkerRoot = git(dirname(fileURLToPath(import.meta.url)), ['rev-parse', '--show-toplevel']).trim()
    const root = process.env.WT_CERTIFICATION_INPUT_ROOT ?? checkerRoot
    const base = resolveBase(root, options.base)
    const subject = options.subject ? resolveCommit(root, options.subject) : undefined
    const files = changedFiles(root, base, subject).filter((file) => isCodeSubject(root, subject, file.path))
    const eslint = createLinter(checkerRoot), problems = []
    for (const file of files) problems.push(...await compare(eslint, root, base, subject, file, checkerRoot))
    for (const problem of problems) console.log(problem)
    console.log(`quality:changed ${files.length} files checked; ${problems.length} regressions`)
    if (!problems.length && process.env.WT_CERTIFICATION_NONCE) console.log(`WT_OWNER_CHECKED=${process.env.WT_CERTIFICATION_NONCE}`)
    return problems.length ? 1 : 0
  } catch (error) { console.error(`quality:changed TOOL ERROR: ${error.message.replace(/[\r\n]/g, ' ')}; pass --base <ref> or WT_QUALITY_BASE`); return 2 }
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await runCli(process.argv.slice(2))
