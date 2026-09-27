import nodeFs from 'node:fs'
import { parse as parseYaml } from './vendor/yaml.mjs'

const absent = (reason, detail) => ({ ok: false, reason, detail })
const LIMIT = 65536

export function splitFrontmatter(text) {
  if (typeof text !== 'string') return absent('absent')
  const hadBom = text.startsWith('\uFEFF')
  const source = hadBom ? text.slice(1) : text
  const firstEnd = source.slice(0, 257).indexOf('\n')
  if (firstEnd > 256 || firstEnd < 0 && source.length > 256) return /^---[ \t]/.test(source) ? absent('oversized') : absent('absent')
  if (firstEnd < 0 || !/^---[ \t]*\r?$/.test(source.slice(0, firstEnd))) return absent('absent')
  const start = firstEnd + 1
  let offset = start
  while (offset - start <= LIMIT) {
    const newlineAt = source.slice(offset, start + LIMIT + 6).indexOf('\n')
    const newline = newlineAt < 0 ? -1 : offset + newlineAt
    const end = newline < 0 ? source.length : newline + 1
    const line = source.slice(offset, newline < 0 ? end : newline)
    if (/^---[ \t]*\r?$/.test(line)) {
      if (offset - start > LIMIT || Buffer.byteLength(source.slice(start, offset)) > LIMIT) return absent('oversized')
      const bodyOffset = (hadBom ? 1 : 0) + end
      return { ok: true, block: source.slice(start, offset), body: text.slice(bodyOffset), bodyOffset, hadBom }
    }
    if (end - start > LIMIT || newline < 0 && source.length - start > LIMIT) return absent('oversized')
    if (newline < 0) return absent('unterminated')
    offset = end
  }
  return absent('oversized')
}

const yamlOptions = { schema: 'failsafe', uniqueKeys: true, strict: true, maxAliasCount: 100, prettyErrors: false }

// Claude documents colon-space in a plain top-level scalar. Never rewrite nested
// structures, quoted values or values that continue onto a following line.
function colonExtension(block) {
  const lines = block.split(/\r?\n/)
  let changed = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let start = 0
    while (start < line.length && /\s/.test(line[start])) start++
    if (start === line.length || "#:'\"[]{}".includes(line[start])) continue
    const colon = line.indexOf(':', start + 1)
    if (colon < 0 || line[colon + 1] !== ' ' && line[colon + 1] !== '\t') continue
    let end = colon + 2
    while (line[end] === ' ' || line[end] === '\t') end++
    const prefix = line.slice(0, end)
    if (prefix.startsWith(' ') || prefix.startsWith('\t')) continue
    let value = line.slice(end)
    for (let hash = value.indexOf('#'); hash >= 0; hash = value.indexOf('#', hash + 1)) {
      if (hash === 0 || value[hash - 1] !== ' ' && value[hash - 1] !== '\t') continue
      let internalBreak = false
      for (let index = hash + 1; index < value.length; index++) {
        const code = value.charCodeAt(index)
        if (code === 10 || code === 13 || code === 0x2028 || code === 0x2029) { internalBreak = true; break }
      }
      if (internalBreak) continue
      let cut = hash - 1
      while (cut > 0 && (value[cut - 1] === ' ' || value[cut - 1] === '\t')) cut--
      value = value.slice(0, cut)
      break
    }
    value = value.trimEnd()
    let hasControl = false
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index)
      if (code <= 31 || code === 127) { hasControl = true; break }
    }
    if (!value || "-?:,[]{}#&*!|>'\"%@`".includes(value[0]) || hasControl || !value.includes(': ') || /\S/.test(lines[i + 1] ?? '') && /^[ \t]+\S/.test(lines[i + 1])) continue
    lines[i] = prefix + JSON.stringify(value)
    changed = true
  }
  return changed ? lines.join('\n') : null
}

export function parseFrontmatter(text) {
  const split = splitFrontmatter(text)
  if (!split.ok) return split
  let data
  let extension = false
  try { data = parseYaml(split.block, yamlOptions) } catch (error) {
    const rewritten = colonExtension(split.block)
    if (!rewritten) return absent('malformed', String(error))
    try { data = parseYaml(rewritten, yamlOptions); extension = true } catch { return absent('malformed', String(error)) }
  }
  if (data === null) data = {}
  if (!data || typeof data !== 'object' || Array.isArray(data)) return absent('malformed', 'top-level mapping required')
  return { ok: true, data, extension, body: split.body, bodyOffset: split.bodyOffset, hadBom: split.hadBom }
}

export function readFrontmatterFile(file, { maxBytes = LIMIT, budget, fs = nodeFs } = {}) {
  let fd
  let result
  try {
    if (fs.constants.O_NONBLOCK === undefined && !fs.statSync(file).isFile()) return absent('not-regular')
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0))
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) result = absent('not-regular')
    else if (budget?.exhausted || (budget && budget.bytes + Math.min(stat.size, maxBytes + 1) > budget.maxBytes)) {
      if (budget) budget.exhausted = 'bytes'
      result = absent('budget')
    } else {
      const buffer = Buffer.allocUnsafe(Math.min(maxBytes + 1, budget ? Math.max(0, budget.maxBytes - budget.bytes) + 1 : maxBytes + 1))
      const count = fs.readSync(fd, buffer, 0, buffer.length, 0)
      if (budget) {
        budget.bytes += count
        if (budget.bytes > budget.maxBytes) budget.exhausted = 'bytes'
      }
      if (budget?.exhausted) result = absent('budget')
      else {
        const text = buffer.toString('utf8', 0, count)
        const parsed = parseFrontmatter(text)
        result = count > maxBytes && (!parsed.ok && ['unterminated', 'oversized'].includes(parsed.reason) || parsed.ok && Buffer.byteLength(text.slice(0, parsed.bodyOffset)) > maxBytes)
          ? absent('oversized') : { ...parsed, truncatedBody: stat.size > count, raw: text }
      }
    }
  } catch (error) { result = absent('io-error', String(error)) }
  if (fd !== undefined) {
    try { fs.closeSync(fd) } catch (error) { result = absent('io-error', String(error)) }
  }
  return result
}
