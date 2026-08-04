import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative, resolve } from 'node:path'

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

export type CitationSweepFinding = CitationFinding & {
  tree: string
}

export type CitationSweepTreeReport =
  | {
      kind: 'working-tree' | 'git-branch'
      tree: string
      status: 'checked'
      scannedFiles: string[]
      citations: CitationMarker[]
      findings: CitationSweepFinding[]
    }
  | {
      kind: 'git-branch'
      tree: string
      status: 'unknown'
      message: string
    }
  | {
      kind: 'declared-limit'
      tree: 'outside-git copies'
      status: 'declared-limit'
      message: string
    }

export type CitationSweepResult = {
  rootDir: string
  scannedTrees: string[]
  treeReports: CitationSweepTreeReport[]
  findings: CitationSweepFinding[]
}

export type CitationSweepOptions = {
  trees?: string[]
  branchMode?: 'unmerged' | 'all' | 'none'
  branches?: string[]
}

export const REPO_PROSE_TREES = [
  'plugin/rules',
  'plugin/agent-templates',
  'plugin/launch-agents/agents',
  'plugin/skills',
] as const

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

export function sweepCitationMarkers(rootDir: string, options: CitationSweepOptions = {}): CitationSweepResult {
  const trees = [...(options.trees ?? REPO_PROSE_TREES)]
  const branchMode = options.branchMode ?? 'unmerged'
  const explicitBranches = [...new Set(options.branches ?? [])]
  const branchNames = [...new Set([...branchesForMode(rootDir, branchMode), ...explicitBranches])]
  const treeReports: CitationSweepTreeReport[] = []

  const workingTreeResult = checkCitationMarkers(rootDir, trees)
  treeReports.push({
    kind: 'working-tree',
    tree: 'working tree',
    status: 'checked',
    scannedFiles: workingTreeResult.scannedFiles,
    citations: workingTreeResult.citations,
    findings: workingTreeResult.findings.map((finding) => ({ ...finding, tree: 'working tree' })),
  })

  for (const branch of branchNames) {
    try {
      const branchResult = checkCitationMarkersInBranch(rootDir, branch, trees)
      treeReports.push(branchResult)
    } catch (error) {
      treeReports.push({
        kind: 'git-branch',
        tree: branch,
        status: 'unknown',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  treeReports.push({
    kind: 'declared-limit',
    tree: 'outside-git copies',
    status: 'declared-limit',
    message:
      'Outside-git copies are not mechanically enumerable from this repository, so this sweep declares them out of reach instead of silently treating them as clean.',
  })

  return {
    rootDir,
    scannedTrees: treeReports.map((report) => report.tree),
    treeReports,
    findings: treeReports.flatMap((report) => (report.status === 'checked' ? report.findings : [])),
  }
}

export function formatCitationSweepReport(result: CitationSweepResult): string {
  const lines = [`citation-marker-check — ${result.rootDir}`]
  const checkedTrees = result.treeReports
    .filter((report): report is Extract<CitationSweepTreeReport, { status: 'checked' }> => report.status === 'checked')
    .map((report) => report.tree)
  lines.push(`scope: covered ${checkedTrees.length} tree(s): ${checkedTrees.join(', ') || '(none)'}`)

  for (const report of result.treeReports) {
    if (report.status === 'unknown') {
      lines.push(`scope: UNKNOWN ${report.tree} (${report.message})`)
      continue
    }
    if (report.status === 'declared-limit') {
      lines.push(`scope: DECLARED LIMIT ${report.tree} (${report.message})`)
    }
  }

  if (result.findings.length === 0) {
    lines.push('No stale or dangling citations across covered trees.')
    return lines.join('\n')
  }

  for (const finding of result.findings) {
    lines.push(`[${finding.tree}] ${finding.message}`)
  }
  return lines.join('\n')
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

function checkCitationMarkersInBranch(rootDir: string, branch: string, trees: string[]): Extract<CitationSweepTreeReport, { status: 'checked' }> {
  const scannedFiles = listBranchMarkdownFiles(rootDir, branch, trees)
  const citations: CitationMarker[] = []

  for (const file of scannedFiles) {
    const content = readGitFile(rootDir, branch, file)
    for (const match of content.matchAll(CITE_RE)) {
      citations.push({
        citedFile: file,
        sourceFile: match[1],
        clauseId: match[2],
        expectedSha256: match[3],
      })
    }
  }

  const findings: CitationSweepFinding[] = []
  for (const citation of citations) {
    let sourceContent: string
    try {
      sourceContent = readGitFile(rootDir, branch, citation.sourceFile)
    } catch {
      findings.push({
        kind: 'dangling',
        tree: branch,
        citedFile: citation.citedFile,
        sourceFile: citation.sourceFile,
        clauseId: citation.clauseId,
        message:
          `Dangling citation on ${branch} in ${citation.citedFile}: ` +
          `${citation.sourceFile}#${citation.clauseId} does not exist in that branch.`,
      })
      continue
    }

    const clause = extractClause(sourceContent, citation.clauseId)
    if (clause === null) {
      findings.push({
        kind: 'dangling',
        tree: branch,
        citedFile: citation.citedFile,
        sourceFile: citation.sourceFile,
        clauseId: citation.clauseId,
        message:
          `Dangling citation on ${branch} in ${citation.citedFile}: ` +
          `${citation.sourceFile}#${citation.clauseId} was not found.`,
      })
      continue
    }

    const actualSha256 = sha256(clause)
    if (actualSha256 !== citation.expectedSha256) {
      findings.push({
        kind: 'stale',
        tree: branch,
        citedFile: citation.citedFile,
        sourceFile: citation.sourceFile,
        clauseId: citation.clauseId,
        expectedSha256: citation.expectedSha256,
        actualSha256,
        message:
          `Stale citation on ${branch} in ${citation.citedFile}: ${citation.sourceFile}#${citation.clauseId} ` +
          `changed (${citation.expectedSha256} -> ${actualSha256}).`,
      })
    }
  }

  return {
    kind: 'git-branch',
    tree: branch,
    status: 'checked',
    scannedFiles,
    citations,
    findings,
  }
}

function listBranchMarkdownFiles(rootDir: string, branch: string, trees: string[]): string[] {
  const output = execGit(rootDir, ['ls-tree', '-r', '--name-only', branch, '--', ...trees])
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.md'))
    .sort()
}

function readGitFile(rootDir: string, branch: string, file: string): string {
  return execGit(rootDir, ['show', `${branch}:${file}`])
}

function branchesForMode(rootDir: string, branchMode: NonNullable<CitationSweepOptions['branchMode']>): string[] {
  if (branchMode === 'none') return []

  const head = currentBranch(rootDir)
  const branches = execGit(rootDir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((branch) => branch !== head)

  if (branchMode === 'all') return branches
  return branches.filter((branch) => !isMergedIntoHead(rootDir, branch))
}

function currentBranch(rootDir: string): string {
  return execGit(rootDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
}

function isMergedIntoHead(rootDir: string, branch: string): boolean {
  try {
    execFileSync('git', ['-C', rootDir, 'merge-base', '--is-ancestor', branch, 'HEAD'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

function execGit(rootDir: string, args: string[]): string {
  return execFileSync('git', ['-C', rootDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
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

function parseArgs(args: string[]): { rootDir: string; trees: string[]; branchMode: 'unmerged' | 'all' | 'none'; branches: string[] } {
  let rootDir = resolve(import.meta.dirname, '../..')
  const trees: string[] = []
  let branchMode: 'unmerged' | 'all' | 'none' = 'unmerged'
  const branches: string[] = []

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
    if (arg === '--tree') {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) throw new Error('--tree requires a value')
      trees.push(value)
      index += 1
      continue
    }
    if (arg === '--branches') {
      const value = args[index + 1]
      if (value !== 'unmerged' && value !== 'all' && value !== 'none') {
        throw new Error('--branches must be one of: unmerged, all, none')
      }
      branchMode = value
      index += 1
      continue
    }
    if (arg === '--branch') {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) throw new Error('--branch requires a value')
      branches.push(value)
      index += 1
      continue
    }
    throw new Error(`unknown argument: ${arg}`)
  }

  return {
    rootDir,
    trees: trees.length > 0 ? trees : [...REPO_PROSE_TREES],
    branchMode,
    branches,
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs(args)
  console.log(
    formatCitationSweepReport(
      sweepCitationMarkers(parsed.rootDir, {
        trees: parsed.trees,
        branchMode: parsed.branchMode,
        branches: parsed.branches,
      }),
    ),
  )
}

export function handleCliError(error: unknown): never {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

const isMain = (() => {
  try {
    const argvPath = process.argv[1]
    if (!argvPath) return false
    return fileURLToPath(import.meta.url) === resolve(argvPath)
  } catch {
    return false
  }
})()

if (isMain) {
  main().catch(handleCliError)
}
