// lint.ts — workflow source linter for @workflow-toolbox/build
//
// Pure string analysis: no fs, no process, no network, no side effects.
// The caller is responsible for reading the file; this module only inspects
// the string content.
//
// Rules enforced (all empirically verified against the Workflow sandbox):
//   R1  — UTF-8 byte length must not exceed MAX_WORKFLOW_BYTES (512 KB)
//   R2  — source must declare `export const meta = { … }`
//   R3  — the meta declaration must be the first non-whitespace statement
//   R4a — the meta object literal must not contain a spread operator (`...`)
//   R4b — the meta object literal must not contain a template literal (backtick)
//   R4c — the meta object literal must not contain a function call
//   R5  — the meta object must not use reserved prototype-chain keys
//   R6  — the meta object must declare `name` and `description`
//   R7  — non-deterministic calls banned at run time: Date.now, Math.random,
//          argless new Date() — they throw in the sandbox and break resume
//   R8  — host APIs unavailable in the sandbox: require(), import…from, process.*
//   R9  — parallel() must receive thunks, not bare promise-returning calls
//
// Comment/string exclusion: a single-pass state machine blanks all content
// inside line comments (//), block comments (/* */), and string literals
// (' " `), preserving newlines so that line-number reporting stays accurate.
// All regex checks run on the blanked copy; meta-span raw-backtick check
// (R4b) runs on the original source before blanking.

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface LintResult {
  errors: string[]
  warnings: string[]
}

/** Maximum allowed workflow source size in UTF-8 bytes (512 KB). */
export const MAX_WORKFLOW_BYTES = 524288

// ---------------------------------------------------------------------------
// Comment / string exclusion pass
// ---------------------------------------------------------------------------

/**
 * Blank all content inside comments and string literals while preserving
 * newlines so that line numbers remain valid for the original source.
 *
 * Escape sequences (\\, \', \") inside strings are handled so an escaped
 * quote does not prematurely close the string context.
 */
function stripCommentsAndStrings(src: string): string {
  const out: string[] = []
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
          // Escaped character — skip both the backslash and the next char
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

    if (ch !== undefined) out.push(ch)
    i++
  }

  return out.join('')
}

// ---------------------------------------------------------------------------
// Meta-span extraction
// ---------------------------------------------------------------------------

/**
 * Locate the meta object literal in the stripped source.
 * Returns the raw substring between (and including) the opening and closing
 * braces, using brace-balanced matching on the stripped text.
 * Returns null when no meta declaration is found.
 */
function extractMetaSpanStripped(stripped: string): string | null {
  const declMatch = /export\s+const\s+meta\s*=\s*\{/.exec(stripped)
  if (!declMatch) return null

  const start = declMatch.index + declMatch[0].length - 1 // index of '{'
  let depth = 0
  let i = start

  while (i < stripped.length) {
    if (stripped[i] === '{') depth++
    else if (stripped[i] === '}') {
      depth--
      if (depth === 0) {
        return stripped.slice(start, i + 1)
      }
    }
    i++
  }

  return null
}

/**
 * Locate the meta object literal in the ORIGINAL (non-stripped) source.
 * Returns the raw substring between the opening and closing braces.
 * Brace matching uses the stripped source offsets mapped back to original.
 */
function extractMetaSpanRaw(src: string, stripped: string): string | null {
  const declMatch = /export\s+const\s+meta\s*=\s*\{/.exec(stripped)
  if (!declMatch) return null

  const start = declMatch.index + declMatch[0].length - 1
  let depth = 0
  let i = start

  while (i < stripped.length) {
    if (stripped[i] === '{') depth++
    else if (stripped[i] === '}') {
      depth--
      if (depth === 0) {
        return src.slice(start, i + 1)
      }
    }
    i++
  }

  return null
}

// ---------------------------------------------------------------------------
// Line-number utilities
// ---------------------------------------------------------------------------

/** Return 1-based line number of the given character offset in src. */
function lineAt(src: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < src.length; i++) {
    if (src[i] === '\n') line++
  }
  return line
}

/** Find the offset of the first match of re in src, or -1. */
function firstMatchOffset(src: string, re: RegExp): number {
  const m = re.exec(src)
  return m ? m.index : -1
}

// ---------------------------------------------------------------------------
// Key-presence helpers (bare-or-quoted, for R5 and R6)
// ---------------------------------------------------------------------------

/**
 * Test whether a key name appears in the meta span either as a bare
 * identifier key or as a JSON-quoted key.  Operates on the stripped span
 * (string contents blanked) so that keys embedded in string values do not
 * produce false positives.  Bare-key search is also performed on the raw span
 * so quoted-key forms (which the stripper blanks) are detected via the raw
 * span for the quoted form.
 */
function metaHasKey(strippedSpan: string, rawSpan: string, key: string): boolean {
  // Bare key: `key:` or `key :`
  const bareRe = new RegExp(`(?:^|[,{\\s])${escapeRe(key)}\\s*:`)
  if (bareRe.test(strippedSpan)) return true

  // Quoted key in raw span: `"key":` or `"key" :`
  const quotedRe = new RegExp(`"${escapeRe(key)}"\\s*:`)
  if (quotedRe.test(rawSpan)) return true

  return false
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ---------------------------------------------------------------------------
// Main linter
// ---------------------------------------------------------------------------

export function lintWorkflowSource(src: string): LintResult {
  const errors: string[] = []
  const warnings: string[] = []

  // ── R1: size cap ──────────────────────────────────────────────────────────
  const byteLength = Buffer.byteLength(src, 'utf8')
  if (byteLength > MAX_WORKFLOW_BYTES) {
    errors.push(
      `Workflow source is too large: ${byteLength} bytes (limit is ${MAX_WORKFLOW_BYTES} bytes / 512 KB). ` +
        `Reduce the workflow size before building.`,
    )
    // No point running further checks on a file that will be rejected outright.
    return { errors, warnings }
  }

  // Strip comments and strings for the structural checks.
  const stripped = stripCommentsAndStrings(src)

  // ── R2: meta declaration must exist ───────────────────────────────────────
  const metaDeclRe = /export\s+const\s+meta\s*=/
  if (!metaDeclRe.test(stripped)) {
    errors.push(
      `Workflow is missing the required meta declaration. ` +
        `Add \`export const meta = { name: '…', description: '…' }\` as the first statement.`,
    )
    return { errors, warnings }
  }

  // ── R3: meta must be the first non-whitespace statement ───────────────────
  const metaOffset = firstMatchOffset(stripped, /export\s+const\s+meta\s*=/)
  const metaLine = lineAt(src, metaOffset)

  // Anything before the meta offset that isn't whitespace counts as code.
  const beforeMeta = stripped.slice(0, metaOffset)
  if (/\S/.test(beforeMeta)) {
    errors.push(
      `\`export const meta\` must be the first statement in the workflow (found at line ${metaLine}). ` +
        `Move it above all other code.`,
    )
  }

  // ── Extract meta spans (stripped + raw) for R4/R5/R6 ────────────────────
  const strippedMetaSpan = extractMetaSpanStripped(stripped)
  const rawMetaSpan = extractMetaSpanRaw(src, stripped)

  if (strippedMetaSpan !== null && rawMetaSpan !== null) {
    // ── R4b: no template literal (backtick) in the RAW meta span ───────────
    // Check raw before any stripping — the stripper erases backticks.
    if (rawMetaSpan.includes('`')) {
      errors.push(
        `meta must be a pure object literal but contains a template literal (backtick). ` +
          `Use plain string values instead.`,
      )
    }

    // ── R4a: no spread in the stripped meta span ──────────────────────────
    if (/\.\.\./.test(strippedMetaSpan)) {
      errors.push(
        `meta must be a pure object literal but contains a spread operator (\`...\`). ` +
          `Expand all values inline.`,
      )
    }

    // ── R4c: no function call in the stripped meta span ──────────────────
    // Heuristic: identifier immediately followed by `(`
    if (/\b[A-Za-z_$][A-Za-z0-9_$]*\s*\(/.test(strippedMetaSpan)) {
      errors.push(
        `meta must be a pure object literal but contains a function call. ` +
          `Replace computed values with plain string or number literals.`,
      )
    }

    // ── R5: reserved prototype-chain keys ────────────────────────────────
    for (const reserved of ['__proto__', 'constructor', 'prototype']) {
      if (metaHasKey(strippedMetaSpan, rawMetaSpan, reserved)) {
        errors.push(`meta uses reserved key \`${reserved}\``)
      }
    }

    // ── R6: required fields: name and description ─────────────────────────
    for (const field of ['name', 'description']) {
      if (!metaHasKey(strippedMetaSpan, rawMetaSpan, field)) {
        errors.push(`meta is missing a \`${field}\` field`)
      }
    }
  }

  // ── R7: banned non-deterministic calls ────────────────────────────────────
  // Date.now — member-access tolerant of whitespace
  {
    const re = /Date\s*\.\s*now\s*\(/g
    let m: RegExpExecArray | null
    while ((m = re.exec(stripped)) !== null) {
      const ln = lineAt(src, m.index)
      errors.push(
        `Banned non-deterministic call \`Date.now()\` at line ${ln}: ` +
          `it throws in the workflow sandbox and breaks resume determinism. ` +
          `Use a timestamp provided by the runtime instead.`,
      )
    }
  }

  // Math.random — member-access tolerant of whitespace
  {
    const re = /Math\s*\.\s*random\s*\(/g
    let m: RegExpExecArray | null
    while ((m = re.exec(stripped)) !== null) {
      const ln = lineAt(src, m.index)
      errors.push(
        `Banned non-deterministic call \`Math.random()\` at line ${ln}: ` +
          `it throws in the workflow sandbox and breaks resume determinism. ` +
          `Use deterministic logic or a seeded value instead.`,
      )
    }
  }

  // new Date() — argless only; new Date(expr) is allowed
  // Match `new Date(` followed by optional whitespace then `)` in stripped src
  {
    const re = /new\s+Date\s*\(\s*\)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(stripped)) !== null) {
      // Reconstruct the call spelling from original source to echo spacing
      const rawCall = src.slice(m.index, m.index + m[0].length)
      const ln = lineAt(src, m.index)
      errors.push(
        `Banned non-deterministic call \`${rawCall}\` at line ${ln}: ` +
          `it throws in the workflow sandbox and breaks resume determinism. ` +
          `Use new Date(timestampMs) with a fixed value instead.`,
      )
    }
  }

  // ── R8: absent host APIs ──────────────────────────────────────────────────
  // require(
  {
    const re = /\brequire\s*\(/g
    let m: RegExpExecArray | null
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
    let m: RegExpExecArray | null
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
    let m: RegExpExecArray | null
    while ((m = re.exec(stripped)) !== null) {
      const ln = lineAt(src, m.index)
      warnings.push(
        `\`process.\` at line ${ln} does not exist in the workflow sandbox. ` +
          `Node.js globals are not available; use runtime-provided values instead.`,
      )
    }
  }

  // ── R9: parallel() with bare agent() calls ────────────────────────────────
  // Heuristic: split each parallel([ ... ]) array literal into its top-level
  // elements and flag any element that contains a call but no arrow function.
  // An element with an arrow anywhere (a thunk, or a .map() producing thunks)
  // is fine even when it nests further calls; an element with a call and no
  // arrow is a promise created eagerly — exactly the mistake R9 exists to
  // catch, including inside MIXED thunk/bare arrays.
  {
    // Find every parallel([…]) block in the stripped source
    const parallelRe = /\bparallel\s*\(\s*\[/g
    let pm: RegExpExecArray | null
    while ((pm = parallelRe.exec(stripped)) !== null) {
      // Extract content up to matching `])`
      const blockStart = pm.index + pm[0].length
      let depth = 1
      let j = blockStart
      while (j < stripped.length && depth > 0) {
        if (stripped[j] === '[') depth++
        else if (stripped[j] === ']') depth--
        j++
      }
      const blockContent = stripped.slice(blockStart, j - 1)

      // Top-level comma split, depth-aware over (), [], {} — strings are
      // already blanked by the stripper, so no string hazards here.
      const elements: string[] = []
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
        break // one warning per parallel block is sufficient
      }
    }
  }

  return { errors, warnings }
}
