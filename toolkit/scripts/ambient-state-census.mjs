import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import ts from 'typescript'

const ROOT = resolve(import.meta.dirname, '..')
const TEST_ROOTS = ['packages', 'examples/test', 'scripts/test']
const CHILD_PROCESS_MODULES = new Set(['child_process', 'node:child_process'])
const PROCESS_FUNCTIONS = new Set(['exec', 'execFile', 'execFileSync', 'execSync', 'fork', 'spawn', 'spawnSync'])
const SEAL_KEYS = ['NPM_CONFIG_PREFIX', 'HOME', 'XDG_STATE_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_PLUGIN_DATA']

// Every accepted ambient read is named by its exact statement text (file, signal, source line text).
// Adding or rewriting one requires a fresh decision; moving it does not. No file-wide exemption.
export const ambientStateAllowList = new Map([
  ["packages/build/test/adopt-installer.test.ts:short-negative-output-match:expect(out).not.toContain('=3')", 'assertion is over controlled fixture output, not ambient process output'],
  ["packages/build/test/adopt-installer.test.ts:short-negative-output-match:expect(out).not.toContain('=1')", 'assertion is over controlled fixture output, not ambient process output'],
  ["packages/build/test/adopt-installer.test.ts:inherited-env-to-child:const res = spawnSync(process.execPath, [script, ...args, '--dir', dir], { encoding: 'utf8', env: { ...process.env, ...env } })", 'case supplies installer-specific fixture state; omitted ambient keys cannot affect the asserted path'],
  ["packages/build/test/artifact-server.test.ts:inherited-env-to-child:const result = spawnSync(env.WT_ARTIFACT_SERVER_TAILSCALE_BINARY, ['ip', '-4'], {", 'case supplies fake tailscale state and an owned port; plugin config and npm roots are not consulted'],
  ["packages/build/test/changelog-skill.test.ts:inherited-env-to-child:const result = spawnSync('git', args, {", 'case invokes git with explicit config isolation; plugin state is not consulted'],
  ["packages/build/test/gate-evidence-guard.test.ts:inherited-env-to-child:const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...HERMETIC } })", 'case invokes a fixture child whose inputs are explicit and does not resolve plugin state'],
  ["packages/build/test/guard-journal-test-isolation.test.ts:real-home-directory:return join(os.homedir(), '.local', 'state', 'wt-guard-journal')", 'isolation lock deliberately computes the real default journal path read-only'],
  ["packages/build/test/guard-journal-test-isolation.test.ts:real-home-directory:// in the harness ever set it — so a spawned hook falls through to os.homedir() and writes to", 'comment documents the deliberate real-home fallback exercised by this isolation lock'],
  ["packages/build/test/guard-journal-test-isolation.test.ts:inherited-env-to-child:const res = spawnSync(process.execPath, [HOOK], {", 'case deliberately inherits the suite-level journal redirect to prove it protects child hooks'],
  ["packages/build/test/guard-journal.test.ts:inherited-env-to-child:return spawnSync(process.execPath, ['--input-type=module', '-e', script], {", 'case pins WT_GUARD_JOURNAL_DIR; the guard does not consult the five plugin-location keys'],
  ["packages/build/test/guard-journal.test.ts:inherited-env-to-child:const result = spawnSync(process.execPath, [SCAN, '--json'], {", 'case pins WT_GUARD_JOURNAL_DIR; the guard does not consult the five plugin-location keys'],
  ["packages/build/test/guard-journal.test.ts:inherited-env-to-child:const result = spawnSync(process.execPath, [SCAN], {", 'case pins WT_GUARD_JOURNAL_DIR; the guard does not consult the five plugin-location keys'],
  ["packages/build/test/guard-observe-mode.test.ts:inherited-env-to-child:const res = spawnSync('git', args, {", 'case pins its journal and payload; the guard does not consult plugin-location state'],
  ["packages/build/test/guard-observe-mode.test.ts:inherited-env-to-child:const scan = spawnSync(process.execPath, [join(BIN_DIR, 'wt-guard-journal-scan.mjs'), '--json'], {", 'case runs a controlled helper process, not a plugin CLI'],
  ["packages/build/test/guard-recurrence-hook.test.ts:inherited-env-to-child:const res = spawnSync(process.execPath, [HOOK], {", 'case pins its journal; the hook path under test does not consult plugin-location state'],
  ["packages/build/test/guard-recurrence-hook.test.ts:inherited-env-to-child:const res = spawnSync(process.execPath, [HOOK], {#2", 'case runs a controlled fixture child, not a plugin CLI'],
  ["packages/build/test/isolated-spawn-report-path-hook.test.ts:inherited-env-to-child:const res = spawnSync(process.execPath, [HOOK], {", 'case pins all report inputs and invokes a narrow hook with no plugin-state lookup'],
  ["packages/build/test/isolated-spawn-report-path-hook.test.ts:inherited-env-to-child:const res = spawnSync(process.execPath, [HOOK], {#2", 'case runs a controlled fixture child, not a plugin CLI'],
  ["packages/build/test/label-intent-producer-hook.test.ts:inherited-env-to-child:const res = spawnSync(process.execPath, [HOOK], {", 'case substitutes PATH with owned fake tools and does not resolve plugin state'],
  ["packages/build/test/lane-activity-cli.test.ts:real-process-table:const out = execFileSync('pgrep', ['-f', marker], { encoding: 'utf8' }).trim()", 'Linux-only integration case deliberately verifies discovery of a real fixture process'],
  ["packages/build/test/lane-probe.test.ts:real-process-table:const out = execFileSync('pgrep', ['-f', marker], { encoding: 'utf8' }).trim()", 'skipped-unless-supported integration case deliberately discovers its real fixture process'],
  ["packages/build/test/lane-saturation-hook.test.ts:inherited-env-to-child:const res = spawnSync(process.execPath, [HOOK], {", 'case runs a controlled fixture process used only for saturation identity'],
  ["packages/build/test/lane-saturation-hook.test.ts:inherited-env-to-child:const res = spawnSync(process.execPath, [HOOK], {#2", 'case runs a controlled fixture process used only for saturation identity'],
  ["packages/build/test/lane-saturation-hook.test.ts:inherited-env-to-child:const res = spawnSync(process.execPath, [HOOK], {#3", 'case runs a controlled fixture process used only for saturation identity'],
  ["packages/build/test/lsp-root.test.ts:short-negative-output-match:expect(output).not.toContain('//')", 'assertion is over generated fixture output, not ambient process output'],
  ["packages/build/test/merge-chain-guard-hook.test.ts:inherited-env-to-child:const res = spawnSync(process.execPath, [HOOK], {", 'case pins the hook payload and suite journal; no plugin-location lookup occurs'],
  ["packages/build/test/merge-target-guard-hook.test.ts:inherited-env-to-child:const res = spawnSync(process.execPath, [HOOK], {", 'case pins the hook payload and suite journal; no plugin-location lookup occurs'],
  ["packages/build/test/missing-package-script-guard-hook.test.ts:inherited-env-to-child:const res = spawnSync(process.execPath, [HOOK], {", 'case pins the hook payload and suite journal; no plugin-location lookup occurs'],
  ["packages/build/test/opencode-envelope-each-source.test.ts:inherited-env-to-child:const result = spawnSync(process.execPath, [", 'zero-task case exits before opencode or plugin-state discovery'],
  ["packages/build/test/opencode-envelope-each-source.test.ts:inherited-env-to-child:const result = spawnSync(process.execPath, [#2", 'argument-validation case exits before opencode or plugin-state discovery'],
  ["packages/build/test/opencode-envelope-each-source.test.ts:inherited-env-to-child:const result = spawnSync(process.execPath, [#3", 'argument-validation case exits before opencode or plugin-state discovery'],
  ["packages/build/test/opencode-envelope-reap.test.ts:real-process-table:const listed = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })", 'platform integration helper deliberately reads the process table to verify reaping'],
  ["packages/build/test/opencode-envelope-reap.test.ts:inherited-env-to-child:const run = spawnSync(", 'case launches only owned fixture processes and asserts their lifecycle'],
  ["packages/build/test/opencode-skill-fence.integration.test.ts:real-home-directory:const env = { ...unfencedProcessEnv, HOME: home, OPENCODE_TEST_HOME: home, CLAUDE_CONFIG_DIR: config, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME:", 'opt-in real e2e case deliberately targets the operator installation home'],
  ["packages/build/test/pgrep-env-dump-guard-hook.test.ts:inherited-env-to-child:const res = spawnSync(process.execPath, [HOOK], {", 'case tests command text classification with an isolated journal; no plugin-state lookup occurs'],
  ["packages/build/test/pilot-runner.test.ts:short-negative-output-match:expect(global.stdout).not.toContain('\\n')", 'assertion is over controlled SDK-resolution fixture output'],
  ["packages/build/test/pilot-runner.test.ts:short-negative-output-match:expect(local.stdout).not.toContain('\\n')", 'assertion is over controlled SDK-resolution fixture output'],
  ["packages/build/test/piped-gate-exit-code-guard-hook.test.ts:inherited-env-to-child:const result = spawnSync(process.execPath, [HOOK], {", 'case pins hook payload and suite journal; no plugin-location lookup occurs'],
  ["packages/build/test/plugin-data-dir.test.ts:inherited-env-to-child:const result = spawnSync(process.execPath, [join(ROOT, 'plugin/bin/lib/plugin-data-dir.selftest.mjs')], {", 'case deliberately varies CLAUDE_PLUGIN_DATA itself and must inherit the remaining test environment'],
  ["packages/build/test/plugin-eval-gate.test.ts:inherited-env-to-child:return spawnSync(process.execPath, [GATE], {", 'case passes all gate inputs explicitly and does not resolve global npm or home state'],
  ["packages/build/test/plugin-hook-registration-drift.test.ts:real-home-directory:HOME: process.env.HOME || homedir(),", 'opt-in real-installation case deliberately locates the operator config home'],
  ["packages/build/test/plugin-hooks.test.ts:short-negative-output-match:expect(r.stdout).not.toContain('deny')", 'assertion is over controlled hook JSON output'],
  ["packages/build/test/plugin-hooks.test.ts:inherited-env-to-child:const res = spawnSync(process.execPath, [LADDER_HOOK], {", 'empty-stdin case exits before any plugin-state lookup'],
  ["packages/build/test/plugin-hooks.test.ts:inherited-env-to-child:const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {", 'child imports pure hook helpers and receives no CLI workload that discovers state'],
  ["packages/build/test/plugin-release-record-guard-hook.test.ts:inherited-env-to-child:const res = spawnSync('git', args, {", 'case uses an explicit hermetic release environment and controlled hook payload'],
  ["packages/build/test/plugin-release-record-guard-hook.test.ts:inherited-env-to-child:const res = spawnSync(process.execPath, [HOOK], {", 'case uses an explicit hermetic release environment and controlled hook payload'],
  ["packages/build/test/plugin-version-alignment.test.ts:inherited-env-to-child:const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...HERMETIC } })", 'case reads only repository manifests supplied by cwd'],
  ["packages/build/test/plugin-version-alignment.test.ts:inherited-env-to-child:return spawnSync(process.execPath, [HOOK], {", 'case reads only repository manifests supplied by cwd'],
  ["packages/build/test/propagation-reminder-hook.test.ts:inherited-env-to-child:const res = spawnSync(process.execPath, [HOOK], {", 'case pins hook payload and suite journal; no plugin-location lookup occurs'],
  ["packages/build/test/propagation-reminder-hook.test.ts:inherited-env-to-child:const res = spawnSync(process.execPath, [HOOK], {#2", 'case runs a controlled fixture child, not a plugin CLI'],
  ["packages/build/test/queue-gate-marker-expiry.test.ts:inherited-env-to-child:const run = spawnSync(process.execPath, ['--input-type=module', '--eval', program], {", 'case pins marker root and time; no plugin-location lookup occurs'],
  ["packages/build/test/run-gate.test.ts:inherited-env-to-child:const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })", 'case invokes an owned fixture gate command and supplies its environment explicitly'],
  ["packages/build/test/second-opinion.test.ts:inherited-env-to-child:const result = spawnSync(process.execPath, [CLI, '--request', f.request, '--out', f.out, '--repo', f.repo, '--route', 'fabel'], { encoding: 'utf8', env: { ...pr", 'argument-validation case supplies CLAUDE_CONFIG_DIR and exits before SDK/global npm resolution'],
  ["packages/build/test/second-opinion.test.ts:inherited-env-to-child:const result = spawnSync(process.execPath, [CLI, '--out', f.out, '--route', 'fable'], { encoding: 'utf8', env: { ...process.env, ...f.env } })", 'argument-validation case exits before config, SDK, or global npm resolution'],
  ["packages/build/test/service-watch.test.ts:inherited-env-to-child:const res = spawnSync(process.execPath, [SERVICE_WATCH, '--once', ...args], {", 'case launches an owned inert process used only for pid identity'],
  ["packages/build/test/stale-date-guard.test.ts:inherited-env-to-child:const res = spawnSync(process.execPath, [HOOK], {", 'case invokes a controlled helper script and does not resolve plugin state'],
  ["packages/build/test/standing-authorizations.test.ts:inherited-env-to-child:return spawnSync(process.execPath, [HOOK], {", 'case invokes a controlled helper script and does not resolve plugin state'],
  ["packages/build/test/suite-lock.test.ts:inherited-env-to-child:return spawnSync(process.execPath, [CLI, ...args], {", 'case invokes the suite-lock helper with a temp lock root'],
  ["packages/build/test/suite-lock.test.ts:inherited-env-to-child:const child = spawn(process.execPath, [CLI, ...args], {", 'case invokes an owned fixture command through the temp suite lock'],
  ["packages/build/test/what-is-running.test.ts:inherited-env-to-child:return spawnSync(process.execPath, [SELFTEST], {", 'case invokes a controlled process-inspection fixture and asserts only injected capabilities'],
  ["packages/debugger/test/resolve-config-dir.test.ts:real-home-directory:const raw = join(homedir(), '.claude')", 'unit test deliberately locks the documented default config-directory fallback'],
  ["packages/patterns/test/adversarial-verification.test.ts:short-negative-output-match:expect(result.trail[0]!.stage).not.toContain('warm')", 'assertion is over in-memory FakeRuntime output, not process output'],
  ["packages/patterns/test/provenance-gate.test.ts:inherited-env-to-child:execFileSync('node', [GUARD_HOOK], {", 'case launches its own verifier fixture and pins marker output'],
  ["packages/patterns/test/provenance-gate.test.ts:inherited-env-to-child:execFileSync('node', [GUARD_HOOK], {#2", 'case launches its own verifier fixture and pins marker output'],
  ["packages/patterns/test/provenance-gate.test.ts:inherited-env-to-child:execFileSync('node', [GUARD_HOOK], {#3", 'case launches its own verifier fixture and pins marker output'],
  ["scripts/test/wt-observer.test.ts:inherited-env-to-child:const child = spawn(process.execPath, [observerScript, ...args], {", 'case launches an owned observer fixture with explicit session paths'],
  ["scripts/test/wt-wake-channel.test.ts:inherited-env-to-child:const child = spawn(process.execPath, [serverScript], {", 'case launches an owned JSON-RPC fixture with explicit transport state'],
])

function testFilesUnder(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return testFilesUnder(path)
    return entry.isFile() && entry.name.endsWith('.test.ts') ? [path] : []
  })
}

function collectChildProcessBindings(sourceFile) {
  const direct = new Set()
  const namespaces = new Set()
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && CHILD_PROCESS_MODULES.has(node.moduleSpecifier.text)) {
      const bindings = node.importClause?.namedBindings
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (PROCESS_FUNCTIONS.has(element.propertyName?.text ?? element.name.text)) direct.add(element.name.text)
        }
      } else if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return { direct, namespaces }
}

function isProcessCall(node, bindings) {
  if (!ts.isCallExpression(node)) return false
  if (ts.isIdentifier(node.expression)) return bindings.direct.has(node.expression.text)
  return ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && bindings.namespaces.has(node.expression.expression.text)
    && PROCESS_FUNCTIONS.has(node.expression.name.text)
}

function position(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

function addFinding(findings, path, sourceFile, node, signal, detail) {
  findings.push({ file: path, line: position(sourceFile, node), signal, detail })
}

function scanFile(absolutePath, root) {
  const source = readFileSync(absolutePath, 'utf8')
  const path = relative(root, absolutePath).replaceAll('\\', '/')
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const bindings = collectChildProcessBindings(sourceFile)
  const findings = []

  const visit = (node) => {
    if (isProcessCall(node, bindings)) {
      const callText = node.getText(sourceFile)
      if (/\.\.\.\s*process\.env/.test(callText)) {
        const sealsAmbientState = SEAL_KEYS.some((key) => new RegExp(`(?:\\b${key}\\b|delete\\s+[^;]*\\.${key}\\b)`).test(callText))
        if (!sealsAmbientState) addFinding(findings, path, sourceFile, node, 'inherited-env-to-child', `none of ${SEAL_KEYS.join(', ')} is sealed`)
      }
      const first = node.arguments[0]
      if (first && ts.isStringLiteralLike(first) && (first.text === 'pgrep' || first.text === 'ps')) {
        addFinding(findings, path, sourceFile, node, 'real-process-table', `${first.text} command`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  const lines = source.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (/\bhomedir\s*\(\s*\)/.test(line)) findings.push({ file: path, line: index + 1, signal: 'real-home-directory', detail: 'os.homedir()' })
    if (/npm\s+root\s+-g|['"]root['"]\s*,\s*['"]-g['"]/.test(line)) findings.push({ file: path, line: index + 1, signal: 'global-npm-root', detail: 'npm root -g' })

    const shortNegative = /expect\(([^\n]*(?:stdout|stderr|output|result|\bout\b)[^\n]*)\)\.not\.toContain\((['"`])([^'"`]*)\2\)/.exec(line)
    if (shortNegative && shortNegative[3].length <= 4) {
      findings.push({ file: path, line: index + 1, signal: 'short-negative-output-match', detail: JSON.stringify(shortNegative[3]) })
    }

    if (/\.listen\(0\b/.test(line)) {
      const nearby = lines.slice(Math.max(0, index - 25), Math.min(lines.length, index + 26)).join('\n')
      if (/(?:request|hit|count)\w*\s*(?:\+\+|\+=\s*1)/i.test(nearby)) {
        findings.push({ file: path, line: index + 1, signal: 'ephemeral-unfiltered-counter', detail: 'listen(0) beside request counter' })
      }
    }
  }
  return withStatementKeys(findings, lines)
}

// An approval names the STATEMENT, never its line number: an unrelated edit above it must not
// turn a correct tree red. Identical statements in one file are told apart by their order.
function withStatementKeys(findings, lines) {
  const seen = new Map()
  return [...findings]
    .sort((left, right) => left.line - right.line || left.signal.localeCompare(right.signal))
    .map((finding) => {
      const base = `${finding.file}:${finding.signal}:${(lines[finding.line - 1] ?? '').trim().slice(0, 160)}`
      const ordinal = (seen.get(base) ?? 0) + 1
      seen.set(base, ordinal)
      return { ...finding, key: ordinal === 1 ? base : `${base}#${ordinal}` }
    })
}

export function scanAmbientState(root = ROOT) {
  return TEST_ROOTS.flatMap((directory) => testFilesUnder(resolve(root, directory)))
    .filter((path) => relative(root, path).replaceAll('\\', '/') !== 'scripts/test/ambient-state-census.test.ts')
    .flatMap((path) => scanFile(path, root))
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.signal.localeCompare(right.signal))
}

export function findingKey(finding) {
  return finding.key
}

// The refusal hands its own remedy: the exact allow-list line to paste, reason left to the author.
export function approvalEntry(finding) {
  return `  [${JSON.stringify(findingKey(finding))}, '<one-line reason>'],`
}

export function checkAmbientState(root = ROOT) {
  const findings = scanAmbientState(root)
  const foundKeys = new Set(findings.map(findingKey))
  return {
    findings,
    unapproved: findings.filter((finding) => !ambientStateAllowList.has(findingKey(finding))),
    stale: [...ambientStateAllowList.keys()].filter((key) => !foundKeys.has(key)),
  }
}

export function formatFinding(finding) {
  const reason = ambientStateAllowList.get(findingKey(finding))
  return `${finding.file}:${finding.line} ${finding.signal}: ${finding.detail}${reason ? ` [allowed: ${reason}]` : ''}`
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const result = checkAmbientState()
  process.stdout.write(`${result.findings.map(formatFinding).join('\n')}${result.findings.length ? '\n' : ''}`)
  if (process.argv.includes('--check') && (result.unapproved.length || result.stale.length)) {
    if (result.unapproved.length) process.stderr.write(`Unapproved ambient-state signals:\n${result.unapproved.map(formatFinding).join('\n')}\nIsolate each one with sealedPluginCliEnv, or add to ambientStateAllowList in scripts/ambient-state-census.mjs:\n${result.unapproved.map(approvalEntry).join('\n')}\n`)
    if (result.stale.length) process.stderr.write(`Stale ambient-state approvals:\n${result.stale.join('\n')}\n`)
    process.exitCode = 1
  }
}
