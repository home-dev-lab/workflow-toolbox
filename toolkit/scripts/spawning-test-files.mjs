import { readdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import ts from 'typescript'

const ROOT = resolve(import.meta.dirname, '..')
const TEST_ROOTS = ['packages', 'examples/test', 'scripts/test']
const CHILD_PROCESS_MODULES = new Set(['child_process', 'node:child_process'])
const PROCESS_FUNCTIONS = new Set([
  'exec',
  'execFile',
  'execFileSync',
  'execSync',
  'fork',
  'spawn',
  'spawnSync',
])

// This is the scheduling-policy boundary. `--check` makes additions fail until
// this complete, mechanically generated population is accepted in one pass.
export const spawningTestFiles = [
  'examples/test/dev-implement-plugin-root-resolution.test.ts',
  'packages/build/test/actionability-gate.test.ts',
  'packages/build/test/actionability-planka-producer.test.ts',
  'packages/build/test/adopt-agents-overlap.test.ts',
  'packages/build/test/adopt-audit-overlap.test.ts',
  'packages/build/test/adopt-changelog-span-cli.test.ts',
  'packages/build/test/adopt-check-hook.test.ts',
  'packages/build/test/adopt-installer.test.ts',
  'packages/build/test/adopt-migrate-dry-run.test.ts',
  'packages/build/test/adopted-wt-lane-consent-parity.test.ts',
  'packages/build/test/artifact-server-context-hook.test.ts',
  'packages/build/test/artifact-server.test.ts',
  'packages/build/test/autonomy-arm.test.ts',
  'packages/build/test/autonomy-watch.test.ts',
  'packages/build/test/cache-keepalive.test.ts',
  'packages/build/test/changelog-skill.test.ts',
  'packages/build/test/changeset-gate.test.ts',
  'packages/build/test/claimed-test-check.test.ts',
  'packages/build/test/claude-executor.test.ts',
  'packages/build/test/cli-bundle-smoke.test.ts',
  'packages/build/test/cli-help.test.ts',
  'packages/build/test/cli.test.ts',
  'packages/build/test/command-repeat-check.test.ts',
  'packages/build/test/commit-signature-check.test.ts',
  'packages/build/test/concurrent-test-guard-hook.test.ts',
  'packages/build/test/env-prerequisite-drift-hook.test.ts',
  'packages/build/test/find-newermt-format-guard-hook.test.ts',
  'packages/build/test/frozen-fidelity-bundle.test.ts',
  'packages/build/test/gate-evidence-guard.test.ts',
  'packages/build/test/git-commit-backtick-guard-hook.test.ts',
  'packages/build/test/guard-journal-family.test.ts',
  'packages/build/test/guard-journal-test-isolation.test.ts',
  'packages/build/test/guard-journal.test.ts',
  'packages/build/test/guard-observe-mode.test.ts',
  'packages/build/test/guard-recurrence-hook.test.ts',
  'packages/build/test/intake-triage.test.ts',
  'packages/build/test/isolated-spawn-report-path-hook.test.ts',
  'packages/build/test/label-intent-producer-hook.test.ts',
  'packages/build/test/lane-activity-cli.test.ts',
  'packages/build/test/lane-consent-check.test.ts',
  'packages/build/test/lane-consent-cli.test.ts',
  'packages/build/test/lane-consent-gate.test.ts',
  'packages/build/test/lane-postdiff-check-cli.test.ts',
  'packages/build/test/lane-probe.test.ts',
  'packages/build/test/lane-saturation-hook.test.ts',
  'packages/build/test/lane-supervisor-core.test.ts',
  'packages/build/test/lesson-harvest-hook.test.ts',
  'packages/build/test/lesson-harvest.test.ts',
  'packages/build/test/lifecycle-phase-identity.test.ts',
  'packages/build/test/live-config-tree-guard-hook.test.ts',
  'packages/build/test/liveness.test.ts',
  'packages/build/test/main-guard-hook.test.ts',
  'packages/build/test/memory-index-check.test.ts',
  'packages/build/test/merge-chain-guard-hook.test.ts',
  'packages/build/test/merge-target-guard-hook.test.ts',
  'packages/build/test/missing-package-script-guard-hook.test.ts',
  'packages/build/test/no-committed-conflict-markers.test.ts',
  'packages/build/test/observer-pairing-check.test.ts',
  'packages/build/test/observer-pairing-guard-hook.test.ts',
  'packages/build/test/opencode-envelope-each-source.test.ts',
  'packages/build/test/opencode-envelope-reap.test.ts',
  'packages/build/test/opencode-plugin-root-resolution.test.ts',
  'packages/build/test/opencode-skill-fence-paths.test.ts',
  'packages/build/test/opencode-skill-fence.integration.test.ts',
  'packages/build/test/opencode-skill-fence.test.ts',
  'packages/build/test/opencode-verifier-entry.test.ts',
  'packages/build/test/orchestrator-core.test.ts',
  'packages/build/test/outbound-guard-hooks.test.ts',
  'packages/build/test/pgrep-env-dump-guard-hook.test.ts',
  'packages/build/test/pilot-card-reconcile.test.ts',
  'packages/build/test/pilot-guard.test.ts',
  'packages/build/test/pilot-model-config.test.ts',
  'packages/build/test/pilot-runner.test.ts',
  'packages/build/test/piped-gate-exit-code-guard-hook.test.ts',
  'packages/build/test/pipestatus-bash-only-guard-hook.test.ts',
  'packages/build/test/plugin-data-dir.test.ts',
  'packages/build/test/plugin-eval-gate.test.ts',
  'packages/build/test/plugin-hook-crash-safety.test.ts',
  'packages/build/test/plugin-hook-paths.test.ts',
  'packages/build/test/plugin-hook-registration-drift.test.ts',
  'packages/build/test/plugin-hooks.test.ts',
  'packages/build/test/plugin-integration.test.ts',
  'packages/build/test/plugin-release-record-guard-hook.test.ts',
  'packages/build/test/plugin-version-alignment.test.ts',
  'packages/build/test/plugin-version-changelog.test.ts',
  'packages/build/test/pr-review-lock-enumeration.test.ts',
  'packages/build/test/prior-art-index.test.ts',
  'packages/build/test/prior-art-launch-guard-hook.test.ts',
  'packages/build/test/probe-claim-guard-hook.test.ts',
  'packages/build/test/propagation-reminder-hook.test.ts',
  'packages/build/test/queue-gate-marker-expiry.test.ts',
  'packages/build/test/queue-not-empty-gate.test.ts',
  'packages/build/test/quota-watch-no-subscription.test.ts',
  'packages/build/test/quota-watch-route.test.ts',
  'packages/build/test/quota-watch-single-instance.test.ts',
  'packages/build/test/report-findings-check.test.ts',
  'packages/build/test/rule-convention-guard.test.ts',
  'packages/build/test/rule-edit-horizon-hook.test.ts',
  'packages/build/test/rules-manifest.test.ts',
  'packages/build/test/run-cost.test.ts',
  'packages/build/test/run-gate.test.ts',
  'packages/build/test/sdk-pilot-lifecycle-full.test.ts',
  'packages/build/test/sdk-pilot-lifecycle-server.test.ts',
  'packages/build/test/second-opinion.test.ts',
  'packages/build/test/service-watch.test.ts',
  'packages/build/test/session-role.test.ts',
  'packages/build/test/session-start-duplicate-hooks.test.ts',
  'packages/build/test/shipped-private-plugins.test.ts',
  'packages/build/test/signatures-workflow-step.test.ts',
  'packages/build/test/spawn-capability-guard-hook.test.ts',
  'packages/build/test/spawn-guards.test.ts',
  'packages/build/test/stale-date-guard.test.ts',
  'packages/build/test/standing-authorizations.test.ts',
  'packages/build/test/suite-lock.test.ts',
  'packages/build/test/unquoted-tool-glob-guard-hook.test.ts',
  'packages/build/test/unsynced-buffer-hook.test.ts',
  'packages/build/test/var-colon-modifier-guard-hook.test.ts',
  'packages/build/test/verdict-cap-check.test.ts',
  'packages/build/test/verifier-cli-guard-envelope-phase.test.ts',
  'packages/build/test/wake-floor.test.ts',
  'packages/build/test/what-is-running.test.ts',
  'packages/build/test/wt-config.test.ts',
  'packages/build/test/wt-lane-helpers.test.ts',
  'packages/build/test/wt-lane-integrate.test.ts',
  'packages/build/test/wt-lane-launcher.test.ts',
  'packages/build/test/wt-lane-wait.test.ts',
  'packages/build/test/wt-pilot-fidelity.test.ts',
  'packages/build/test/wt-shipped-twin-check-hook.test.ts',
  'packages/debugger/test/stop-hook.integration.test.ts',
  'packages/patterns/test/provenance-gate.test.ts',
  'scripts/test/child-process-coverage.test.ts',
  'scripts/test/citation-marker-check.test.ts',
  'scripts/test/label-intent-lens.test.ts',
  'scripts/test/suite-under-load.test.ts',
  'scripts/test/wt-observer.test.ts',
  'scripts/test/wt-wake-channel.test.ts',
]

function testFilesUnder(directory) {
  const entries = readdirSync(directory, { withFileTypes: true })
  return entries.flatMap((entry) => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return testFilesUnder(path)
    return entry.isFile() && entry.name.endsWith('.test.ts') ? [path] : []
  })
}

function moduleName(node) {
  if (!ts.isCallExpression(node) || node.arguments.length !== 1) return undefined
  const argument = node.arguments[0]
  if (!ts.isStringLiteral(argument) || !CHILD_PROCESS_MODULES.has(argument.text)) return undefined
  if (ts.isIdentifier(node.expression) && (node.expression.text === 'require' || node.expression.text === 'import')) return argument.text
  return undefined
}

function collectBindings(sourceFile) {
  const direct = new Set()
  const namespaces = new Set()

  const collectNamedBindings = (bindings) => {
    if (!ts.isObjectBindingPattern(bindings)) return
    for (const element of bindings.elements) {
      const imported = element.propertyName?.getText(sourceFile) ?? element.name.getText(sourceFile)
      if (PROCESS_FUNCTIONS.has(imported) && ts.isIdentifier(element.name)) direct.add(element.name.text)
    }
  }

  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && CHILD_PROCESS_MODULES.has(node.moduleSpecifier.text)) {
      const clause = node.importClause
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          if (PROCESS_FUNCTIONS.has(element.propertyName?.text ?? element.name.text)) direct.add(element.name.text)
        }
      } else if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        namespaces.add(clause.namedBindings.name.text)
      }
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      let initializer = node.initializer
      if (ts.isAwaitExpression(initializer)) initializer = initializer.expression
      if (moduleName(initializer)) {
        if (ts.isIdentifier(node.name)) namespaces.add(node.name.text)
        else collectNamedBindings(node.name)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return { direct, namespaces }
}

function spawnsProcess(path) {
  const source = readFileSync(path, 'utf8')
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const { direct, namespaces } = collectBindings(sourceFile)
  let found = false
  const visit = (node) => {
    if (found) return
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && direct.has(node.expression.text)) found = true
      if (ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && namespaces.has(node.expression.expression.text)
        && PROCESS_FUNCTIONS.has(node.expression.name.text)) found = true
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

export function scanSpawningTestFiles(root = ROOT) {
  return TEST_ROOTS.flatMap((directory) => testFilesUnder(resolve(root, directory)))
    .filter(spawnsProcess)
    .map((path) => relative(root, path).replaceAll('\\', '/'))
    .sort()
}

export function checkSpawningTestFiles(root = ROOT) {
  const found = scanSpawningTestFiles(root)
  const configured = new Set(spawningTestFiles)
  const missing = found.filter((path) => !configured.has(path))
  const stale = spawningTestFiles.filter((path) => !found.includes(path))
  return { found, missing, stale }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const result = checkSpawningTestFiles()
  if (process.argv.includes('--check')) {
    if (result.missing.length || result.stale.length) {
      if (result.missing.length) process.stderr.write(`Process-spawning tests missing from the scheduling policy:\n${result.missing.join('\n')}\n`)
      if (result.stale.length) process.stderr.write(`Stale scheduling-policy entries:\n${result.stale.join('\n')}\n`)
      process.exitCode = 1
    }
  } else {
    process.stdout.write(`${result.found.join('\n')}\n`)
  }
}
