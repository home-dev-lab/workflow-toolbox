import fs from 'node:fs'
import path from 'node:path'
import { knowledgeBaseReadAllowed } from './knowledge-base-index.mjs'

const READ_TOOLS = ['Read', 'Glob', 'Grep']
const WRITE_TOOLS = ['Edit', 'Write', 'Bash']

function confined(root, requested) {
  if (typeof requested !== 'string' || !requested) return false
  const absolute = path.resolve(root, requested)
  let probe = absolute
  const suffix = []
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe)
    if (parent === probe) return false
    suffix.unshift(path.basename(probe)); probe = parent
  }
  const resolved = path.resolve(fs.realpathSync(probe), ...suffix)
  const relative = path.relative(fs.realpathSync(root), resolved)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function bashConfined(root, command) {
  if (typeof command !== 'string' || !command.trim()) return false
  // The SDK sandbox is the filesystem boundary. This lexical filter is defense in depth for
  // obvious escapes; an interpreter can always construct a path without spelling it here.
  if (/(?:^|[\s'"=])(?:\.\.[\\/]|~[\\/]|\$(?:HOME|TMPDIR|TEMP|TMP)\b|\$\{)/.test(command)) return false
  if (/(?:^|[\s'"=(:,])\.\.(?=$|[\s'"),;&|\\/])/.test(command)) return false
  const absolutePaths = command.match(/(?:[A-Za-z]:[\\/]|\/)[^\s'";|&<>)]*/g) ?? []
  return absolutePaths.every((candidate) => confined(root, candidate))
}

export function executorTools(readOnly) {
  return readOnly ? [...READ_TOOLS, 'Write'] : [...READ_TOOLS, ...WRITE_TOOLS]
}

export function executorCanUseTool(root, report, readOnly, toolName, input, { knowledgeBaseIndex = null } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { behavior: 'deny', message: `invalid tool input: ${toolName}` }
  if (READ_TOOLS.includes(toolName)) {
    const requested = input.file_path ?? input.path ?? root
    let allowed = confined(root, requested) || (readOnly && toolName === 'Read' && knowledgeBaseReadAllowed(knowledgeBaseIndex, requested))
    const pattern = toolName === 'Glob' ? input.pattern : input.glob ?? input.pattern
    if (allowed && (toolName === 'Glob' || toolName === 'Grep') && typeof pattern === 'string' && /[\\/]/.test(pattern)) {
      const segments = pattern.split(/[\\/]/)
      const wildcard = segments.findIndex((segment) => /[*?[{]/.test(segment))
      const prefix = segments.slice(0, wildcard < 0 ? segments.length : wildcard).join(path.sep) || '.'
      allowed = confined(root, path.resolve(root, String(input.path ?? root), prefix))
    }
    return allowed ? { behavior: 'allow' } : { behavior: 'deny', message: `path outside worktree: ${String(requested)}` }
  }
  if (toolName === 'Write' || toolName === 'Edit') {
    const requested = input.file_path ?? input.path
    const allowed = readOnly ? toolName === 'Write' && path.resolve(String(requested)) === report : confined(root, requested)
    return allowed ? { behavior: 'allow' } : { behavior: 'deny', message: `write outside allowed path: ${String(requested)}` }
  }
  if (toolName === 'Bash' && !readOnly) {
    return bashConfined(root, input.command) ? { behavior: 'allow' } : { behavior: 'deny', message: 'Bash command may escape the worktree' }
  }
  return { behavior: 'deny', message: `tool refused: ${toolName}` }
}

export function parseExecutorArgs(argv) {
  const options = { dir: null, model: null, brief: null, log: null, timeout: 5400, role: null, knowledgeBaseIndex: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dir') options.dir = argv[++i] ?? null
    else if (arg === '--model') options.model = argv[++i] ?? null
    else if (arg === '--brief') options.brief = argv[++i] ?? null
    else if (arg === '--log') options.log = argv[++i] ?? null
    else if (arg === '--timeout') options.timeout = Number(argv[++i])
    else if (arg === '--role') options.role = argv[++i] ?? null
    else if (arg === '--knowledge-base-index') options.knowledgeBaseIndex = argv[++i] ?? null
    else if (arg === '--help' || arg === '-h') return { help: true }
    else return { error: `unknown argument: ${arg}` }
  }
  if (!options.dir || !options.model || !options.brief) return { error: 'missing required --dir, --model, or --brief' }
  if (!Number.isFinite(options.timeout) || options.timeout <= 0) return { error: '--timeout must be a positive number of seconds' }
  if (!['tdd', 'harden', 'critic', 'review', 'refutation'].includes(options.role)) return { error: '--role must be tdd, harden, critic, review, or refutation' }
  options.dir = path.resolve(options.dir); options.brief = path.resolve(options.brief)
  options.log = path.resolve(options.log ?? path.join(options.dir, '.lane', 'run.log'))
  if (options.knowledgeBaseIndex) options.knowledgeBaseIndex = path.resolve(options.knowledgeBaseIndex)
  return options
}

export function executorBrief(options) {
  const brief = fs.readFileSync(options.brief, 'utf8')
  const match = /Write the report to `([^`]+)`/.exec(brief)
  if (!match) throw new Error('brief does not name its report path')
  const report = path.resolve(match[1])
  const laneDir = path.join(fs.realpathSync(options.dir), '.lane')
  if (path.dirname(report) !== laneDir || !new RegExp(`^${options.role}-report\\.[A-Za-z0-9-]+\\.md$`).test(path.basename(report))) {
    throw new Error(`brief report path is not a nonce lane report: ${report}`)
  }
  // Read-only is decided by the phase the lifecycle launched, never by text inside the brief.
  const readOnly = ['critic', 'review', 'refutation'].includes(options.role)
  const embedded = []
  for (const entry of fs.readdirSync(path.dirname(options.brief), { withFileTypes: true })) {
    const file = path.join(path.dirname(options.brief), entry.name)
    if (!entry.isFile() || file === options.brief) continue
    const stat = fs.statSync(file)
    if (stat.size > 1024 * 1024) throw new Error(`launch input exceeds 1 MiB: ${file}`)
    embedded.push(`### ${file}\n\n\`\`\`text\n${fs.readFileSync(file, 'utf8')}\n\`\`\``)
  }
  const prompt = `${brief}${embedded.length ? `\n\n## Embedded launch inputs (runner-owned)\n\n${embedded.join('\n\n')}\n` : ''}`
  return { prompt, report, readOnly }
}
