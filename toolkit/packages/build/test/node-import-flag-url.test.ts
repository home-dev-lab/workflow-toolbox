import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Node's --import / --loader take a module SPECIFIER, i.e. a URL. A bare OS path works on POSIX
// by accident and crashes on Windows (`d:\...` is read as the URL scheme 'd:',
// ERR_UNSUPPORTED_ESM_URL_SCHEME). This guard reads every tracked test and plugin script that
// hands one of those flags a value, and requires that value to be built as a URL.

const REPO = resolve(__dirname, '../../../..')
const SELF = basename(__filename)
const FLAG = '--(?:import|loader|experimental-loader)'
// `'--import', <expr>` in an argv array.
const ARRAY_FORM = new RegExp(`['"\`]${FLAG}['"\`]\\s*,\\s*([^,\\]\\n]+)`, 'g')
// `--import=<value>` inside a string or template (NODE_OPTIONS, a single argv entry).
const INLINE_FORM = new RegExp(`${FLAG}=(\\$\\{[^}]*\\}|[^\\s'"\`,]+)`, 'g')

const URL_EXPRESSION = /^pathToFileURL\(.*\)\.href$/s
const URL_LITERAL = /^['"`](?:file|data):/
const URL_TEMPLATE = /^(?:\$\{pathToFileURL\(.*\)\.href\}|file:|data:)/s

function declaredValue(source: string, identifier: string) {
  return new RegExp(`\\b(?:const|let|var)\\s+${identifier}\\s*=\\s*([^\\n]+)`).exec(source)?.[1]?.trim() ?? null
}

function importFlagViolations(source: string) {
  const found: Array<{ value: string, ok: boolean }> = []
  for (const match of source.matchAll(ARRAY_FORM)) {
    const value = (match[1] ?? '').trim()
    const resolved = /^[A-Za-z_$][\w$]*$/.test(value) ? declaredValue(source, value) ?? value : value
    found.push({ value, ok: URL_EXPRESSION.test(resolved) || URL_LITERAL.test(resolved) })
  }
  for (const match of source.matchAll(INLINE_FORM)) {
    const value = match[1] ?? ''
    found.push({ value, ok: URL_TEMPLATE.test(value) })
  }
  return found
}

function trackedScripts() {
  const listing = execFileSync('git', ['ls-files', '-z', '--', 'toolkit', 'plugin'], { cwd: REPO, encoding: 'utf8' })
  return listing.split('\0').filter((file) => /\.(?:[cm]?[jt]s)$/.test(file) && !file.includes('/node_modules/') && !file.includes('/dist/') && basename(file) !== SELF)
}

describe('node --import / --loader arguments are URLs', () => {
  it('flags a bare path and accepts the URL spellings', () => {
    const sample = [
      "const BAD = fileURLToPath(new URL('./x.mjs', import.meta.url))",
      "const GOOD = pathToFileURL(fileURLToPath(new URL('./x.mjs', import.meta.url))).href",
      "spawnSync(node, ['--import', BAD, cli])",
      "spawnSync(node, ['--import', GOOD, cli])",
      "spawnSync(node, ['--import', pathToFileURL(stub).href, cli])",
      "spawnSync(node, ['--loader', '/abs/loader.mjs'])",
      'const env = { NODE_OPTIONS: `--import=${preload}` }',
      'const env2 = { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` }',
      "const env3 = { NODE_OPTIONS: '--import=data:text/javascript,1' }",
    ].join('\n')
    expect(importFlagViolations(sample).map(({ value, ok }) => `${ok ? 'ok' : 'BAD'} ${value}`)).toEqual([
      'BAD BAD',
      'ok GOOD',
      'ok pathToFileURL(stub).href',
      "BAD '/abs/loader.mjs'",
      'BAD ${preload}',
      'ok ${pathToFileURL(preload).href}',
      'ok data:text/javascript',
    ])
  })

  it('every tracked test and plugin script passes a URL', () => {
    const files = trackedScripts()
    const seen: string[] = []
    const violations: string[] = []
    for (const file of files) {
      for (const { value, ok } of importFlagViolations(readFileSync(resolve(REPO, file), 'utf8'))) {
        seen.push(file)
        if (!ok) violations.push(`${file}: ${value}`)
      }
    }
    // Witnesses: files known to spawn with --import; a scan that misses them scanned nothing.
    expect(seen).toEqual(expect.arrayContaining([
      'toolkit/packages/build/test/pilot-decision-store.test.ts',
      'toolkit/packages/build/test/quota-probe-token.test.ts',
      'toolkit/packages/build/test/service-watch.test.ts',
    ]))
    expect(violations).toEqual([])
  })
})
