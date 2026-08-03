import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

export type CitationMarker = {
  citedFile: string
  sourceFile: string
  clauseId: string
  expectedSha256: string
}

export type CitationFinding =
  | {
      kind: 'dangling'
      citedFile: string
      sourceFile: string
      clauseId: string
      message: string
    }
  | {
      kind: 'stale'
      citedFile: string
      sourceFile: string
      clauseId: string
      expectedSha256: string
      actualSha256: string
      message: string
    }

export type CitationCheckResult = {
  scannedTrees: string[]
  scannedFiles: string[]
  citations: CitationMarker[]
  findings: CitationFinding[]
}

const CITE_RE = /<!--\s*cite:\s+([^\s#]+)#([A-Za-z0-9._/-]+)\s+sha256:([a-f0-9]{64})\s*-->/g
const CLAUSE_START_RES = [
  /<!--\s*clause:\s*([A-Za-z0-9._/-]+):start\s*-->/g,
  /<!--\s*embedded-copy:([A-Za-z0-9._/-]+):start\s*-->/g,
]

/**
 * Citation markers make declared copies checkable; they do NOT make undeclared
 * copies discoverable. An unmarked paraphrase stays invisible, which is why the
 * preferred remedy is still a reference to the source file instead of copied
 * prose. This checker only answers the narrower question it can decide
 * mechanically: in THIS working tree, across the exact trees the caller
 * enumerates, does each declared citation still point at a real source clause,
 * and does that clause still hash to the value the citation last confirmed?
 *
 * Clause ids are explicit block markers, not line numbers or guessed heading
 * anchors. Line numbers drift when edits land above the clause. Heading anchors
 * couple the locator to heading wording and usually cover too much text. The
 * convention instead names a block delimited by `<!-- clause: <id>:start/end -->`;
 * the checker also accepts the older `embedded-copy:<id>:start/end` form because
 * it already serves as an explicit block id in this repository.
 */
export function checkCitationMarkers(rootDir: string, trees: string[]): CitationCheckResult {
  const scannedFiles = listMarkdownFiles(rootDir, trees)
  const citations: CitationMarker[] = []

  for (const absPath of scannedFiles) {
    const content = readFileSync(absPath, 'utf8')
    for (const match of content.matchAll(CITE_RE)) {
      citations.push({
        citedFile: relative(rootDir, absPath),
        sourceFile: match[1],
        clauseId: match[2],
        expectedSha256: match[3],
      })
    }
  }

  const findings: CitationFinding[] = []

  for (const citation of citations) {
    const sourceAbsPath = join(rootDir, citation.sourceFile)
    let sourceContent: string
    try {
      sourceContent = readFileSync(sourceAbsPath, 'utf8')
    } catch {
      findings.push({
        kind: 'dangling',
        citedFile: citation.citedFile,
        sourceFile: citation.sourceFile,
        clauseId: citation.clauseId,
        message:
          `Dangling citation in ${citation.citedFile}: ` +
          `${citation.sourceFile}#${citation.clauseId} does not exist in this working tree.`,
      })
      continue
    }

    const clause = extractClause(sourceContent, citation.clauseId)
    if (clause === null) {
      findings.push({
        kind: 'dangling',
        citedFile: citation.citedFile,
        sourceFile: citation.sourceFile,
        clauseId: citation.clauseId,
        message:
          `Dangling citation in ${citation.citedFile}: ` +
          `${citation.sourceFile}#${citation.clauseId} was not found.`,
      })
      continue
    }

    const actualSha256 = sha256(clause)
    if (actualSha256 !== citation.expectedSha256) {
      findings.push({
        kind: 'stale',
        citedFile: citation.citedFile,
        sourceFile: citation.sourceFile,
        clauseId: citation.clauseId,
        expectedSha256: citation.expectedSha256,
        actualSha256,
        message:
          `Stale citation in ${citation.citedFile}: ${citation.sourceFile}#${citation.clauseId} ` +
          `changed (${citation.expectedSha256} -> ${actualSha256}).`,
      })
    }
  }

  return {
    scannedTrees: [...trees],
    scannedFiles: scannedFiles.map((absPath) => relative(rootDir, absPath)),
    citations,
    findings,
  }
}

export function extractClause(content: string, clauseId: string): string | null {
  const endRes = [
    new RegExp(`<!--\\s*clause:\\s*${escapeForRegExp(clauseId)}:end\\s*-->`),
    new RegExp(`<!--\\s*embedded-copy:${escapeForRegExp(clauseId)}:end\\s*-->`),
  ]

  for (const startRe of CLAUSE_START_RES) {
    startRe.lastIndex = 0
    for (const match of content.matchAll(startRe)) {
      if (match[1] !== clauseId) continue
      const startIndex = (match.index ?? 0) + match[0].length
      const afterStart = content.slice(startIndex)
      for (const endRe of endRes) {
        const endMatch = endRe.exec(afterStart)
        if (endMatch === null || endMatch.index === undefined) continue
        return afterStart.slice(0, endMatch.index)
      }
      return null
    }
  }

  return null
}

export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function listMarkdownFiles(rootDir: string, trees: string[]): string[] {
  const files: string[] = []
  for (const tree of trees) {
    const absTree = join(rootDir, tree)
    let stats
    try {
      stats = statSync(absTree)
    } catch {
      continue
    }
    if (!stats.isDirectory()) continue
    walk(absTree, files)
  }
  return files.sort()
}

function walk(dir: string, files: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(absPath, files)
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(absPath)
    }
  }
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
