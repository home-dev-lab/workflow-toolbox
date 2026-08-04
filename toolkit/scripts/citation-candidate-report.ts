import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkCitationMarkers, extractClause, REPO_PROSE_TREES, type CitationMarker } from './citation-marker-check.ts'

export const PROSE_SURFACES = [
  { kind: 'flat', path: 'plugin/rules', fileName: '.md' },
  { kind: 'flat', path: 'plugin/agent-templates', fileName: '.md' },
  { kind: 'flat', path: 'plugin/launch-agents/agents', fileName: '.md' },
  { kind: 'skills', path: 'plugin/skills' },
] as const

export const MIN_SHARED_WORDS = 8
const MIN_NON_TRIVIAL_WORD_LENGTH = 4
const WORD_RE = /[A-Za-z0-9]+(?:['/-][A-Za-z0-9]+)*/g
const HTML_COMMENT_RE = /<!--([\s\S]*?)-->/g

export interface Token {
  word: string
  line: number
  startOffset: number
  endOffset: number
}

export interface ProseFile {
  path: string
  content: string
  tokens: Token[]
}

export interface CandidateOccurrence {
  file: string
  line: number
  startToken: number
  wordCount: number
}

export interface CitationOverlap {
  citedFile: string
  sourceFile: string
  clauseId: string
}

export interface CandidateGroup {
  sharedText: string
  truncatedText: string
  normalizedText: string
  wordCount: number
  occurrences: CandidateOccurrence[]
  markedCitations: CitationOverlap[]
}

export interface CandidateReport {
  rootDir: string
  minSharedWords: number
  filesScanned: string[]
  candidateGroups: CandidateGroup[]
  markedOverlapGroups: number
  markedCitationCount: number
  genuinelyUnmarkedGroups: number
}

interface SeedOccurrence {
  fileIndex: number
  startToken: number
}

interface ClauseWords {
  citation: CitationMarker
  normalizedText: string
  familyFiles: Set<string>
}

function normalizeWord(raw: string): string | null {
  const normalized = raw.toLowerCase()
  if (normalized.length < MIN_NON_TRIVIAL_WORD_LENGTH) return null
  if (!/[a-z]/.test(normalized)) return null
  return normalized
}

export function tokenizeNonTrivialWords(content: string): Token[] {
  const tokens: Token[] = []
  const visibleContent = content.replaceAll(HTML_COMMENT_RE, (comment) => comment.replace(/[^\n]/g, ' '))
  let line = 1
  let cursor = 0

  for (const match of visibleContent.matchAll(WORD_RE)) {
    const index = match.index ?? 0
    for (let offset = cursor; offset < index; offset += 1) {
      if (visibleContent.charCodeAt(offset) === 10) line += 1
    }
    cursor = index

    const normalized = normalizeWord(match[0])
    if (normalized === null) continue

    const startOffset = index
    const endOffset = index + match[0].length
    tokens.push({ word: normalized, line, startOffset, endOffset })
  }

  return tokens
}

function listFilesMatching(dir: string, suffix: string, exclude = new Set<string>()): string[] {
  let stats
  try {
    stats = statSync(dir)
  } catch {
    return []
  }
  if (!stats.isDirectory()) return []

  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix) && !exclude.has(entry.name))
    .map((entry) => join(dir, entry.name))
    .sort()
}

function walkMarkdownFiles(dir: string, files: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkMarkdownFiles(absPath, files)
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.md')) files.push(absPath)
  }
}

export function collectProseFiles(rootDir: string): ProseFile[] {
  const absPaths: string[] = []

  for (const surface of PROSE_SURFACES) {
    const absDir = join(rootDir, surface.path)
    if (surface.kind === 'flat') {
      absPaths.push(...listFilesMatching(absDir, surface.fileName, surface.exclude))
      continue
    }

    let skillDirs
    try {
      skillDirs = readdirSync(absDir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const skillDir of skillDirs) {
      if (!skillDir.isDirectory()) continue
      const skillRoot = join(absDir, skillDir.name)
      const skillFile = join(skillRoot, 'SKILL.md')
      try {
        if (statSync(skillFile).isFile()) absPaths.push(skillFile)
      } catch {
        // Missing SKILL.md is ignored: the brief scopes the current tree, not an idealized one.
      }

      const referencesDir = join(skillRoot, 'references')
      try {
        if (statSync(referencesDir).isDirectory()) walkMarkdownFiles(referencesDir, absPaths)
      } catch {
        // Some skills have no references dir.
      }
    }
  }

  return [...new Set(absPaths)]
    .sort()
    .map((absPath) => {
      const content = readFileSync(absPath, 'utf8')
      return {
        path: relative(rootDir, absPath),
        content,
        tokens: tokenizeNonTrivialWords(content),
      }
    })
}

function snippetFrom(file: ProseFile, startToken: number, wordCount: number): string {
  const start = file.tokens[startToken]
  const end = file.tokens[startToken + wordCount - 1]
  if (!start || !end) return ''
  return file.content.slice(start.startOffset, end.endOffset).replace(/\s+/g, ' ').trim()
}

function truncate(text: string, max = 160): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function distinctFileCount(occurrences: SeedOccurrence[]): number {
  return new Set(occurrences.map((occurrence) => occurrence.fileIndex)).size
}

function extendSharedRun(files: ProseFile[], left: SeedOccurrence, right: SeedOccurrence): number {
  const leftTokens = files[left.fileIndex]?.tokens ?? []
  const rightTokens = files[right.fileIndex]?.tokens ?? []
  const leftPrevious = leftTokens[left.startToken - 1]?.word
  const rightPrevious = rightTokens[right.startToken - 1]?.word
  if (leftPrevious !== undefined && leftPrevious === rightPrevious) return 0

  let length = 0
  while (
    left.startToken + length < leftTokens.length &&
    right.startToken + length < rightTokens.length &&
    leftTokens[left.startToken + length]?.word === rightTokens[right.startToken + length]?.word
  ) {
    length += 1
  }
  return length
}

function clauseWordsFor(rootDir: string, citations: CitationMarker[]): ClauseWords[] {
  const cache = new Map<string, string>()
  const familyFiles = new Map<string, Set<string>>()
  const clauses: ClauseWords[] = []

  for (const citation of citations) {
    const key = `${citation.sourceFile}#${citation.clauseId}`
    const family = familyFiles.get(key) ?? new Set<string>([citation.sourceFile])
    family.add(citation.citedFile)
    familyFiles.set(key, family)
  }

  for (const citation of citations) {
    let sourceContent = cache.get(citation.sourceFile)
    if (sourceContent === undefined) {
      sourceContent = readFileSync(join(rootDir, citation.sourceFile), 'utf8')
      cache.set(citation.sourceFile, sourceContent)
    }
    const clause = extractClause(sourceContent, citation.clauseId)
    if (clause === null) continue
    clauses.push({
      citation,
      normalizedText: tokenizeNonTrivialWords(clause)
        .map((token) => token.word)
        .join(' '),
      familyFiles: familyFiles.get(`${citation.sourceFile}#${citation.clauseId}`) ?? new Set([citation.sourceFile, citation.citedFile]),
    })
  }

  return clauses
}

function markCitationOverlaps(rootDir: string, candidateGroups: CandidateGroup[]): { markedOverlapGroups: number; markedCitationCount: number } {
  const citations = checkCitationMarkers(rootDir, [...REPO_PROSE_TREES]).citations
  const clauses = clauseWordsFor(rootDir, citations)

  for (const group of candidateGroups) {
    const files = new Set(group.occurrences.map((occurrence) => occurrence.file))
    for (const clause of clauses) {
      if (!files.has(clause.citation.citedFile) || !files.has(clause.citation.sourceFile)) continue
      if ([...files].some((file) => !clause.familyFiles.has(file))) continue
      if (!clause.normalizedText.includes(group.normalizedText)) continue
      group.markedCitations.push({
        citedFile: clause.citation.citedFile,
        sourceFile: clause.citation.sourceFile,
        clauseId: clause.citation.clauseId,
      })
    }
  }

  const overlappingGroups = candidateGroups.filter((group) => group.markedCitations.length > 0)
  return {
    markedOverlapGroups: overlappingGroups.length,
    markedCitationCount: overlappingGroups.reduce((sum, group) => sum + group.markedCitations.length, 0),
  }
}

function containsOccurrence(container: CandidateOccurrence, nested: CandidateOccurrence): boolean {
  return (
    container.file === nested.file &&
    nested.startToken >= container.startToken &&
    nested.startToken + nested.wordCount <= container.startToken + container.wordCount
  )
}

function pruneNestedGroups(groups: CandidateGroup[]): CandidateGroup[] {
  const kept: CandidateGroup[] = []

  for (const group of groups) {
    const covered = kept.some((candidate) => group.occurrences.every((occurrence) => candidate.occurrences.some((existing) => containsOccurrence(existing, occurrence))))
    if (!covered) kept.push(group)
  }

  return kept
}

export function findCitationCandidates(rootDir: string): CandidateReport {
  const files = collectProseFiles(rootDir)
  const seeds = new Map<string, SeedOccurrence[]>()

  files.forEach((file, fileIndex) => {
    for (let startToken = 0; startToken <= file.tokens.length - MIN_SHARED_WORDS; startToken += 1) {
      const key = file.tokens
        .slice(startToken, startToken + MIN_SHARED_WORDS)
        .map((token) => token.word)
        .join(' ')
      const bucket = seeds.get(key)
      if (bucket) bucket.push({ fileIndex, startToken })
      else seeds.set(key, [{ fileIndex, startToken }])
    }
  })

  const groups = new Map<string, CandidateGroup>()

  for (const occurrences of seeds.values()) {
    if (occurrences.length < 2 || distinctFileCount(occurrences) < 2) continue

    for (let leftIndex = 0; leftIndex < occurrences.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < occurrences.length; rightIndex += 1) {
        const left = occurrences[leftIndex]
        const right = occurrences[rightIndex]
        if (left.fileIndex === right.fileIndex) continue

        const wordCount = extendSharedRun(files, left, right)
        if (wordCount < MIN_SHARED_WORDS) continue

        const leftFile = files[left.fileIndex]
        const normalizedText = leftFile.tokens
          .slice(left.startToken, left.startToken + wordCount)
          .map((token) => token.word)
          .join(' ')
        const group =
          groups.get(normalizedText) ??
          {
            sharedText: snippetFrom(leftFile, left.startToken, wordCount),
            truncatedText: truncate(snippetFrom(leftFile, left.startToken, wordCount)),
            normalizedText,
            wordCount,
            occurrences: [],
            markedCitations: [],
          }

        const addOccurrence = (seed: SeedOccurrence): void => {
          const file = files[seed.fileIndex]
          const key = `${file.path}:${seed.startToken}`
          if (group.occurrences.some((occurrence) => `${occurrence.file}:${occurrence.startToken}` === key)) return
          group.occurrences.push({
            file: file.path,
            line: file.tokens[seed.startToken]?.line ?? 1,
            startToken: seed.startToken,
            wordCount,
          })
        }

        addOccurrence(left)
        addOccurrence(right)
        groups.set(normalizedText, group)
      }
    }
  }

  const candidateGroups = pruneNestedGroups(
    [...groups.values()]
    .filter((group) => new Set(group.occurrences.map((occurrence) => occurrence.file)).size > 1)
    .map((group) => ({
      ...group,
      occurrences: [...group.occurrences].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
      markedCitations: [...group.markedCitations],
    }))
    .sort(
      (a, b) =>
        b.wordCount - a.wordCount ||
        b.occurrences.length - a.occurrences.length ||
        a.truncatedText.localeCompare(b.truncatedText),
    ),
  )

  const { markedOverlapGroups, markedCitationCount } = markCitationOverlaps(rootDir, candidateGroups)

  return {
    rootDir,
    minSharedWords: MIN_SHARED_WORDS,
    filesScanned: files.map((file) => file.path),
    candidateGroups,
    markedOverlapGroups,
    markedCitationCount,
    genuinelyUnmarkedGroups: candidateGroups.length - markedOverlapGroups,
  }
}

function printReport(report: CandidateReport, limit: number): void {
  console.log(`citation-candidate-report — ${report.rootDir}`)
  console.log(
    `scope: ${report.filesScanned.length} authored prose file(s) across plugin/rules, plugin/agent-templates, plugin/launch-agents/agents, plugin/skills/*/SKILL.md, and plugin/skills/*/references/**`,
  )
  console.log(
    `match rule: ${report.minSharedWords}+ consecutive non-trivial words (length >= ${MIN_NON_TRIVIAL_WORD_LENGTH}, must contain a letter), exact word-sequence match after case-folding`,
  )
  console.log('')
  console.log(`candidate groups: ${report.candidateGroups.length}`)
  console.log(
    `groups overlapping existing citation markers: ${report.markedOverlapGroups} (covering ${report.markedCitationCount} marked citation(s))`,
  )
  console.log(`genuinely unmarked groups: ${report.genuinelyUnmarkedGroups}`)
  console.log('')

  const visibleGroups = report.candidateGroups.slice(0, limit)
  for (const [index, group] of visibleGroups.entries()) {
    const marker = group.markedCitations.length > 0 ? `MARKED x${group.markedCitations.length}` : 'UNMARKED'
    console.log(`${index + 1}. [${marker}] ${group.truncatedText}`)
    console.log(`   ${group.wordCount} word(s), ${group.occurrences.length} occurrence(s)`)
    for (const occurrence of group.occurrences) {
      console.log(`   - ${occurrence.file}:${occurrence.line}`)
    }
    console.log('')
  }

  if (report.candidateGroups.length > visibleGroups.length) {
    console.log(`... ${report.candidateGroups.length - visibleGroups.length} more group(s) omitted; rerun with --limit ${report.candidateGroups.length} to print all.`)
  }
}

function parseArgs(args: string[]): { rootDir: string; limit: number } {
  let rootDir = resolve(import.meta.dirname, '../..')
  let limit = 20

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--') continue
    if (arg === '--root') {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) throw new Error('--root requires a value')
      rootDir = resolve(value)
      index += 1
      continue
    }
    if (arg === '--limit') {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) throw new Error('--limit requires a value')
      const parsed = Number.parseInt(value, 10)
      if (!Number.isInteger(parsed) || parsed <= 0) throw new Error('--limit must be a positive integer')
      limit = parsed
      index += 1
      continue
    }
    throw new Error(`unknown argument: ${arg}`)
  }

  return { rootDir, limit }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { rootDir, limit } = parseArgs(args)
  printReport(findCitationCandidates(rootDir), limit)
}

export function handleCliError(error: unknown): never {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

const isMain = (() => {
  try {
    const argvPath = process.argv[1]
    if (!argvPath) return false
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argvPath)
  } catch {
    return false
  }
})()

if (isMain) {
  main().catch(handleCliError)
}
