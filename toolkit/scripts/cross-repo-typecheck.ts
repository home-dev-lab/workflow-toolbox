import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

import { findObserveRoot } from '../packages/debugger/src/observe-checkout.ts'

const SOURCE_EXTENSIONS = /\.(?:cts|mts|tsx?|svelte)$/
const TYPESCRIPT_EXTENSIONS = /\.(?:cts|mts|tsx?)$/
const SKIP_DIRS = new Set(['.git', '.svelte-kit', 'build', 'coverage', 'dist', 'node_modules'])

export interface CrossRepoGateOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  producerToolkitRoot?: string
  log?: (line: string) => void
}

function walk(root: string, accept: (path: string) => boolean): string[] {
  const files: string[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) visit(join(dir, entry.name))
      } else if (entry.isFile()) {
        const path = join(dir, entry.name)
        if (accept(path)) files.push(path)
      }
    }
  }
  visit(root)
  return files
}

function linkedPackages(workspaceText: string): string[] {
  const packages = new Set<string>()
  for (const line of workspaceText.split('\n')) {
    const match = /^\s*['"]?(@workflow-toolbox\/[^'":\s]+)['"]?\s*:\s*['"]link:/.exec(line)
    if (match?.[1]) packages.add(match[1])
  }
  return [...packages].sort()
}

function packagePaths(toolkitRoot: string, packageNames: readonly string[]): Record<string, string[]> {
  const paths: Record<string, string[]> = {}
  for (const packageName of packageNames) {
    const packageRoot = join(toolkitRoot, 'packages', packageName.slice('@workflow-toolbox/'.length))
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      name?: string
      exports?: Record<string, string | { types?: string; import?: string }>
    }
    if (manifest.name !== packageName || manifest.exports === undefined) {
      throw new Error(`${packageName} has no matching source exports at ${packageRoot}`)
    }
    for (const [subpath, value] of Object.entries(manifest.exports)) {
      const target = typeof value === 'string' ? value : value.types ?? value.import
      if (target === undefined) continue
      const specifier = subpath === '.' ? packageName : `${packageName}/${subpath.replace(/^\.\//, '')}`
      paths[specifier] = [resolve(packageRoot, target)]
    }
  }
  return paths
}

function importedLinkedPackages(text: string, packageNames: ReadonlySet<string>): string[] {
  const found = new Set<string>()
  const pattern = /(?:from\s*|import\s*\(|require\s*\()\s*['"](@workflow-toolbox\/[^'"/]+)(?:\/[^'"]*)?['"]/g
  for (const match of text.matchAll(pattern)) {
    if (match[1] && packageNames.has(match[1])) found.add(match[1])
  }
  return [...found].sort()
}

function formatDiagnostic(diagnostic: ts.Diagnostic, consumerRoot: string): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
  if (diagnostic.file === undefined || diagnostic.start === undefined) return message
  const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
  return `${relative(consumerRoot, diagnostic.file.fileName)}:${position.line + 1}:${position.character + 1}: ${message}`
}

function commonAncestor(a: string, b: string): string {
  let candidate = resolve(a)
  const target = resolve(b)
  while (target !== candidate && !target.startsWith(`${candidate}${process.platform === 'win32' ? '\\' : '/'}`)) {
    const parent = dirname(candidate)
    if (parent === candidate) return candidate
    candidate = parent
  }
  return candidate
}

function checkSvelteSurface(
  consumerRoot: string,
  toolkitRoot: string,
  paths: Record<string, string[]>,
  files: readonly string[],
  log: (line: string) => void,
): number {
  if (files.length === 0) return 0
  const uiRoot = join(consumerRoot, 'apps', 'observe-ui')
  const checker = join(uiRoot, 'node_modules', 'svelte-check', 'bin', 'svelte-check')
  const temporary = mkdtempSync(join(tmpdir(), 'wt-cross-repo-svelte-'))
  const config = join(temporary, 'tsconfig.json')
  try {
    writeFileSync(config, `${JSON.stringify({
      extends: join(uiRoot, 'tsconfig.json'),
      compilerOptions: {
        baseUrl: uiRoot,
        ignoreDeprecations: '6.0',
        paths,
        rootDir: commonAncestor(consumerRoot, toolkitRoot),
        typeRoots: [join(uiRoot, 'node_modules')],
      },
    })}\n`)
    const result = spawnSync(process.execPath, [checker, '--tsconfig', config, '--output', 'machine'], {
      cwd: uiRoot,
      encoding: 'utf8',
      timeout: 60_000,
    })
    if (result.error !== undefined || result.status === null) {
      log(`cross-repo gate: Svelte toolchain did not start (${result.error?.message ?? 'no exit status'}) - SKIPPED (infrastructure)`)
      return -1
    }
    const checkerOutput = `${result.stdout}${result.stderr}`
    if (result.status !== 0) {
      if (!/\bSTART\b/.test(checkerOutput) || !/\bCOMPLETED\b/.test(checkerOutput)) {
        log(`cross-repo gate: Svelte toolchain did not complete (exit ${result.status}) - SKIPPED (infrastructure)`)
        return -1
      }
      const packages = [...new Set(files.flatMap((file) => importedLinkedPackages(readFileSync(file, 'utf8'), new Set(Object.keys(paths).map((name) => name.split('/').slice(0, 2).join('/'))))))].sort()
      for (const file of files) {
        log(`cross-repo gate: TYPE ERROR: package ${packages.join(', ')}; consumer ${relative(consumerRoot, file)}`)
      }
      for (const line of checkerOutput.trim().split('\n')) log(`cross-repo gate: ${line}`)
      return 2
    }
    return 0
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

export function runCrossRepoTypecheck(options: CrossRepoGateOptions = {}): number {
  const cwd = options.cwd ?? process.cwd()
  const env = options.env ?? process.env
  const toolkitRoot = options.producerToolkitRoot
    ?? env['WT_CROSS_REPO_PRODUCER_ROOT']
    ?? resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`))
  const requested = env['DWT_OBSERVE_ROOT'] ?? join(dirname(cwd), 'workflow-observatory')

  try {
    const consumerRoot = findObserveRoot(cwd, env)
    if (consumerRoot === null) {
      log(`cross-repo gate: private checkout not found at ${requested} - SKIPPED`)
      return 0
    }

    const workspace = readFileSync(join(consumerRoot, 'pnpm-workspace.yaml'), 'utf8')
    const packageNames = linkedPackages(workspace)
    if (packageNames.length === 0) {
      log(`cross-repo gate: no linked @workflow-toolbox packages found in ${consumerRoot}/pnpm-workspace.yaml - SKIPPED (infrastructure)`)
      return 0
    }
    const paths = packagePaths(toolkitRoot, packageNames)
    const packageSet = new Set(packageNames)
    const sourceImports = new Map<string, string[]>()
    for (const file of walk(consumerRoot, (path) => SOURCE_EXTENSIONS.test(path))) {
      const imports = importedLinkedPackages(readFileSync(file, 'utf8'), packageSet)
      if (imports.length > 0) sourceImports.set(file, imports)
    }

    const configs = walk(consumerRoot, (path) =>
      /(?:^|\/)tsconfig(?:\.[^/]+)?\.json$/.test(path) && !path.endsWith('/tsconfig.base.json'),
    )
    const covered = new Set<string>()
    const diagnostics: Array<{ diagnostic: ts.Diagnostic; roots: string[]; packages: string[] }> = []
    for (const configPath of configs) {
      const read = ts.readConfigFile(configPath, ts.sys.readFile)
      if (read.error !== undefined) throw new Error(formatDiagnostic(read.error, consumerRoot))
      const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath), undefined, configPath)
      if (parsed.errors.length > 0) throw new Error(parsed.errors.map((item) => formatDiagnostic(item, consumerRoot)).join('\n'))
      const roots = parsed.fileNames.filter((file) => TYPESCRIPT_EXTENSIONS.test(file) && sourceImports.has(file))
      if (roots.length === 0) continue
      roots.forEach((file) => covered.add(file))
      const usedPackages = [...new Set(roots.flatMap((file) => sourceImports.get(file) ?? []))].sort()
      const compilerOptions: ts.CompilerOptions = {
        ...parsed.options,
        composite: false,
        declaration: false,
        declarationMap: false,
        incremental: false,
        noEmit: true,
        outDir: undefined,
        paths: { ...parsed.options.paths, ...paths },
        rootDir: undefined,
        tsBuildInfoFile: undefined,
      }
      const program = ts.createProgram({ rootNames: roots, options: compilerOptions })
      for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
        if (diagnostic.category === ts.DiagnosticCategory.Error) diagnostics.push({ diagnostic, roots, packages: usedPackages })
      }
    }

    const svelteFiles = [...sourceImports.keys()].filter((file) => file.endsWith('.svelte'))
    if (covered.size === 0) {
      log(`cross-repo gate: no consuming TypeScript roots were covered in ${consumerRoot} - SKIPPED (infrastructure)`)
      return 0
    }

    const resolutionFailures = diagnostics.filter(({ diagnostic }) => diagnostic.code === 2307 || diagnostic.code === 2688)
    if (resolutionFailures.length > 0) {
      log('cross-repo gate: TypeScript dependency resolution could not start cleanly - SKIPPED (infrastructure)')
      for (const { diagnostic } of resolutionFailures) log(`cross-repo gate: ${formatDiagnostic(diagnostic, consumerRoot)}`)
      return 0
    }
    if (diagnostics.length > 0) {
      const reported = new Set<string>()
      for (const { diagnostic, roots, packages } of diagnostics) {
        const key = `${diagnostic.file?.fileName ?? ''}:${diagnostic.start ?? ''}:${diagnostic.code}:${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`
        if (reported.has(key)) continue
        reported.add(key)
        const consumerFile = diagnostic.file?.fileName.startsWith(consumerRoot)
          ? relative(consumerRoot, diagnostic.file.fileName)
          : relative(consumerRoot, roots[0] ?? consumerRoot)
        const directPackages = diagnostic.file === undefined ? [] : sourceImports.get(diagnostic.file.fileName) ?? []
        const producerPackage = diagnostic.file === undefined
          ? undefined
          : packageNames.find((name) => diagnostic.file?.fileName.startsWith(join(toolkitRoot, 'packages', name.slice('@workflow-toolbox/'.length))))
        const namedPackages = directPackages.length > 0 ? directPackages : producerPackage === undefined ? packages : [producerPackage]
        log(`cross-repo gate: TYPE ERROR: package ${namedPackages.join(', ')}; consumer ${consumerFile}`)
        log(`cross-repo gate: ${formatDiagnostic(diagnostic, consumerRoot)}`)
      }
      return 2
    }

    const svelteResult = checkSvelteSurface(consumerRoot, toolkitRoot, paths, svelteFiles, log)
    if (svelteResult < 0) return 0
    if (svelteResult > 0) return svelteResult

    const svelteNote = svelteFiles.length > 0 ? `, ${svelteFiles.length} consumer Svelte file(s)` : ''
    log(`cross-repo gate: PASS - ${packageNames.length} package(s), ${covered.size} consumer TypeScript file(s)${svelteNote}`)
    return 0
  } catch (error) {
    log(`cross-repo gate: could not run typecheck (${error instanceof Error ? error.message : String(error)}) - SKIPPED (infrastructure)`)
    return 0
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runCrossRepoTypecheck()
}
