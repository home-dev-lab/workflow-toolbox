import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const LANGUAGES = ['typescript', 'java', 'kotlin', 'groovy', 'python', 'svelte', 'vue']
export const CAPABILITIES = ['diagnostics', 'symbol-overview', 'symbol-lookup', 'declarations', 'references', 'implementations']

function cell(archive, language, capability) {
  const path = capability === 'diagnostics'
    ? join(archive, language, 'available', 'verdict.json')
    : join(archive, language, capability, 'available', 'verdict.json')
  if (!existsSync(path)) return { verdict: 'unmeasured', reason: 'no archive' }
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'))
    return ['parity', 'no parity', 'unmeasured'].includes(data.verdict) ? data : { verdict: 'unmeasured', reason: 'invalid verdict archive' }
  } catch {
    return { verdict: 'unmeasured', reason: 'invalid verdict archive' }
  }
}

export function renderParityTable(data, languages = LANGUAGES) {
  const rows = CAPABILITIES.map((capability) => [capability, ...languages.map((language) => data[language]?.[capability] ?? { verdict: 'unmeasured', reason: 'no archive' })])
  const markdown = [`| capability | ${languages.join(' | ')} |`, `| --- | ${languages.map(() => '---').join(' | ')} |`, ...rows.map(([capability, ...values]) => `| ${capability} | ${values.map((value) => value.verdict === 'unmeasured' ? `unmeasured (${value.reason})` : value.verdict).join(' | ')} |`)].join('\n')
  return { markdown: `${markdown}\n`, json: Object.fromEntries(languages.map((language) => [language, Object.fromEntries(CAPABILITIES.map((capability) => [capability, data[language]?.[capability] ?? { verdict: 'unmeasured', reason: 'no archive' }]))])) }
}

export function writeParityTable(archive) {
  const data = Object.fromEntries(LANGUAGES.map((language) => [language, Object.fromEntries(CAPABILITIES.map((capability) => [capability, cell(archive, language, capability)]))]))
  const rendered = renderParityTable(data)
  writeFileSync(join(archive, 'parity-table.md'), rendered.markdown)
  writeFileSync(join(archive, 'parity-table.json'), `${JSON.stringify(rendered.json, null, 2)}\n`)
  return rendered
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const archive = process.argv[2]
  if (!archive || process.argv.length !== 3) throw new Error('usage: lsp-parity-table.mjs <archive-root>')
  process.stdout.write(writeParityTable(resolve(archive)).markdown)
}
