#!/usr/bin/env node
// validate-workflow.mjs — standalone workflow linter CLI
//
// Derived from @workflow-toolbox/build's lint.ts and kept in sync with it.
// The plugin-integration test suite enforces parity between this script and
// lintWorkflowSource() from the toolkit — if you update the rules in lint.ts
// you MUST update this file to match.
//
// Usage:  node validate-workflow.mjs <path-to-workflow>
// Exit 0: no errors (warnings may be printed)
// Exit 1: errors found, bad usage, or unreadable file
//
// Output format:
//   errors   →  "  ERROR <message>"   (two spaces — parity suite greps /^ {2}ERROR /)
//   warnings →  "  warn: <message>"   (two spaces)
//   verdict  →  one summary line at the end

import { readFileSync } from 'node:fs'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_WORKFLOW_BYTES = 524288

// ---------------------------------------------------------------------------
// Comment / string exclusion pass
// ---------------------------------------------------------------------------

function stripCommentsAndStrings(src) {
  const out = []
  let i = 0
  const n = src.length

  while (i < n) {
    const ch = src[i]

    // Line comment: // … \n
    if (ch === '/' && src[i + 1] === '/') {
      out.push(' ', ' ')
      i += 2
      while (i < n && src[i] !== '\n') {
        out.push(' ')
        i++
      }
      continue
    }

    // Block comment: /* … */
    if (ch === '/' && src[i + 1] === '*') {
      out.push(' ', ' ')
      i += 2
      while (i < n) {
        if (src[i] === '*' && src[i + 1] === '/') {
          out.push(' ', ' ')
          i += 2
          break
        }
        out.push(src[i] === '\n' ? '\n' : ' ')
        i++
      }
      continue
    }

    // String literals: single-quote, double-quote, backtick
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      out.push(' ')
      i++
      while (i < n) {
        const sc = src[i]
        if (sc === '\\') {
          out.push(' ')
          i++
          if (i < n) {
            out.push(src[i] === '\n' ? '\n' : ' ')
            i++
          }
          continue
        }
        if (sc === quote) {
          out.push(' ')
          i++
          break
        }
        out.push(sc === '\n' ? '\n' : ' ')
        i++
      }
      continue
    }

    out.push(ch)
    i++
  }

  return out.join('')
}

// ---------------------------------------------------------------------------
// Meta-span extraction
// ---------------------------------------------------------------------------

function extractMetaSpanStripped(stripped) {
  const declMatch = /export\s+const\s+meta\s*=\s*\{/.exec(stripped)
  if (!declMatch) return null

  const start = declMatch.index + declMatch[0].length - 1
  let depth = 0
  let i = start

  while (i < stripped.length) {
    if (stripped[i] === '{') depth++
    else if (stripped[i] === '}') {
      depth--
      if (depth === 0) return stripped.slice(start, i + 1)
    }
    i++
  }
  return null
}

function extractMetaSpanRaw(src, stripped) {
  const declMatch = /export\s+const\s+meta\s*=\s*\{/.exec(stripped)
  if (!declMatch) return null

  const start = declMatch.index + declMatch[0].length - 1
  let depth = 0
  let i = start

  while (i < stripped.length) {
    if (stripped[i] === '{') depth++
    else if (stripped[i] === '}') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
    i++
  }
  return null
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function lineAt(src, offset) {
  let line = 1
  for (let i = 0; i < offset && i < src.length; i++) {
    if (src[i] === '\n') line++
  }
  return line
}

function firstMatchOffset(src, re) {
  const m = re.exec(src)
  return m ? m.index : -1
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function metaHasKey(strippedSpan, rawSpan, key) {
  const bareRe = new RegExp(`(?:^|[,{\\s])${escapeRe(key)}\\s*:`)
  if (bareRe.test(strippedSpan)) return true
  const quotedRe = new RegExp(`"${escapeRe(key)}"\\s*:`)
  if (quotedRe.test(rawSpan)) return true
  return false
}

// ---------------------------------------------------------------------------
// Linter (same rules as lint.ts — kept in sync manually)
// ---------------------------------------------------------------------------

function lintWorkflowSource(src) {
  const errors = []
  const warnings = []

  // R1: size cap
  const byteLength = Buffer.byteLength(src, 'utf8')
  if (byteLength > MAX_WORKFLOW_BYTES) {
    errors.push(
      `Workflow source is too large: ${byteLength} bytes (limit is ${MAX_WORKFLOW_BYTES} bytes / 512 KB). ` +
        `Reduce the workflow size before building.`,
    )
    return { errors, warnings }
  }

  const stripped = stripCommentsAndStrings(src)

  // R2: meta declaration must exist
  const metaDeclRe = /export\s+const\s+meta\s*=/
  if (!metaDeclRe.test(stripped)) {
    errors.push(
      `Workflow is missing the required meta declaration. ` +
        `Add \`export const meta = { name: '…', description: '…' }\` as the first statement.`,
    )
    return { errors, warnings }
  }

  // R3: meta must be the first non-whitespace statement
  const metaOffset = firstMatchOffset(stripped, /export\s+const\s+meta\s*=/)
  const metaLine = lineAt(src, metaOffset)
  const beforeMeta = stripped.slice(0, metaOffset)
  if (/\S/.test(beforeMeta)) {
    errors.push(
      `\`export const meta\` must be the first statement in the workflow (found at line ${metaLine}). ` +
        `Move it above all other code.`,
    )
  }

  // Extract meta spans
  const strippedMetaSpan = extractMetaSpanStripped(stripped)
  const rawMetaSpan = extractMetaSpanRaw(src, stripped)

  if (strippedMetaSpan !== null && rawMetaSpan !== null) {
    // R4b: no template literal in raw meta span
    if (rawMetaSpan.includes('`')) {
      errors.push(
        `meta must be a pure object literal but contains a template literal (backtick). ` +
          `Use plain string values instead.`,
      )
    }

    // R4a: no spread in stripped meta span
    if (/\.\.\./.test(strippedMetaSpan)) {
      errors.push(
        `meta must be a pure object literal but contains a spread operator (\`...\`). ` +
          `Expand all values inline.`,
      )
    }

    // R4c: no function call in stripped meta span
    if (/\b[A-Za-z_$][A-Za-z0-9_$]*\s*\(/.test(strippedMetaSpan)) {
      errors.push(
        `meta must be a pure object literal but contains a function call. ` +
          `Replace computed values with plain string or number literals.`,
      )
    }

    // R5: reserved keys
    for (const reserved of ['__proto__', 'constructor', 'prototype']) {
      if (metaHasKey(strippedMetaSpan, rawMetaSpan, reserved)) {
        errors.push(`meta uses reserved key \`${reserved}\``)
      }
    }

    // R6: required fields
    for (const field of ['name', 'description']) {
      if (!metaHasKey(strippedMetaSpan, rawMetaSpan, field)) {
        errors.push(`meta is missing a \`${field}\` field`)
      }
    }
  }

  // R7: banned non-deterministic calls

  // Date.now
  {
    const re = /Date\s*\.\s*now\s*\(/g
    let m
    while ((m = re.exec(stripped)) !== null) {
      const ln = lineAt(src, m.index)
      errors.push(
        `Banned non-deterministic call \`Date.now()\` at line ${ln}: ` +
          `it throws in the workflow sandbox and breaks resume determinism. ` +
          `Use a timestamp provided by the runtime instead.`,
      )
    }
  }

  // Math.random
  {
    const re = /Math\s*\.\s*random\s*\(/g
    let m
    while ((m = re.exec(stripped)) !== null) {
      const ln = lineAt(src, m.index)
      errors.push(
        `Banned non-deterministic call \`Math.random()\` at line ${ln}: ` +
          `it throws in the workflow sandbox and breaks resume determinism. ` +
          `Use deterministic logic or a seeded value instead.`,
      )
    }
  }

  // new Date() — argless only
  {
    const re = /new\s+Date\s*\(\s*\)/g
    let m
    while ((m = re.exec(stripped)) !== null) {
      const rawCall = src.slice(m.index, m.index + m[0].length)
      const ln = lineAt(src, m.index)
      errors.push(
        `Banned non-deterministic call \`${rawCall}\` at line ${ln}: ` +
          `it throws in the workflow sandbox and breaks resume determinism. ` +
          `Use new Date(timestampMs) with a fixed value instead.`,
      )
    }
  }

  // R8: absent host APIs

  // require(
  {
    const re = /\brequire\s*\(/g
    let m
    while ((m = re.exec(stripped)) !== null) {
      const ln = lineAt(src, m.index)
      warnings.push(
        `\`require(\` at line ${ln} does not exist in the workflow sandbox. ` +
          `Use the runtime APIs provided by the \`rt\` argument instead.`,
      )
    }
  }

  // import … from
  {
    const re = /\bimport\b[^;]*\bfrom\b/g
    let m
    while ((m = re.exec(stripped)) !== null) {
      const ln = lineAt(src, m.index)
      warnings.push(
        `\`import\` … \`from\` at line ${ln} does not exist in the workflow sandbox. ` +
          `All dependencies must be provided by the runtime.`,
      )
    }
  }

  // process.*
  {
    const re = /\bprocess\./g
    let m
    while ((m = re.exec(stripped)) !== null) {
      const ln = lineAt(src, m.index)
      warnings.push(
        `\`process.\` at line ${ln} does not exist in the workflow sandbox. ` +
          `Node.js globals are not available; use runtime-provided values instead.`,
      )
    }
  }

  // R9: parallel() with bare agent() calls
  {
    const parallelRe = /\bparallel\s*\(\s*\[/g
    let pm
    while ((pm = parallelRe.exec(stripped)) !== null) {
      const blockStart = pm.index + pm[0].length
      let depth = 1
      let j = blockStart
      while (j < stripped.length && depth > 0) {
        if (stripped[j] === '[') depth++
        else if (stripped[j] === ']') depth--
        j++
      }
      const blockContent = stripped.slice(blockStart, j - 1)

      // Top-level comma split (depth-aware) — flag any element that contains
      // a call but no arrow function, so MIXED thunk/bare arrays are caught.
      const elements = []
      let elStart = 0
      let elDepth = 0
      for (let k = 0; k < blockContent.length; k++) {
        const ch = blockContent[k]
        if (ch === '(' || ch === '[' || ch === '{') elDepth++
        else if (ch === ')' || ch === ']' || ch === '}') elDepth--
        else if (ch === ',' && elDepth === 0) {
          elements.push(blockContent.slice(elStart, k))
          elStart = k + 1
        }
      }
      elements.push(blockContent.slice(elStart))

      const hasBareCall = elements.some(
        (el) => /[A-Za-z_$][A-Za-z0-9_$]*\s*\(/.test(el) && !el.includes('=>'),
      )

      if (hasBareCall) {
        warnings.push(
          `\`parallel()\` received bare promise-returning calls instead of thunks. ` +
            `Wrap each item in an arrow function: \`() => agent('…')\` so the ` +
            `workflow engine can control when each task starts.`,
        )
        break
      }
    }
  }

  return { errors, warnings }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
if (args.length === 0) {
  process.stderr.write('Usage: node validate-workflow.mjs <path-to-workflow>\n')
  process.exit(1)
}

const filePath = args[0]
let src
try {
  src = readFileSync(filePath, 'utf8')
} catch (err) {
  process.stderr.write(`Cannot read file: ${filePath}\n`)
  process.exit(1)
}

const result = lintWorkflowSource(src)

for (const e of result.errors) {
  process.stdout.write(`  ERROR ${e}\n`)
}
for (const w of result.warnings) {
  process.stdout.write(`  warn: ${w}\n`)
}

if (result.errors.length === 0) {
  process.stdout.write(`Workflow OK${result.warnings.length > 0 ? ` (${result.warnings.length} warning(s))` : ''}\n`)
  process.exit(0)
} else {
  process.stdout.write(`Workflow has ${result.errors.length} error(s) — fix before deploying\n`)
  process.exit(1)
}
