// shipped-dts-dependency-gate.test.ts — verify that consumers can resolve every
// external import left in a published declaration artifact.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const PACKAGES_DIR = join(REPO_ROOT, 'toolkit/packages')
const NODE_BUILTINS = new Set(builtinModules)

type PackageManifest = {
  name: string
  private?: boolean
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

type Finding = {
  packageName: string
  specifier: string
  declaration: string
}

function packageNameFor(specifier: string): string {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/')
  return specifier.split('/')[0]!
}

function declarationFiles(dir: string): string[] {
  if (!existsSync(dir)) throw new Error(`published declaration directory is missing: ${dir}`)
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...declarationFiles(path))
    else if (entry.isFile() && entry.name.endsWith('.d.ts')) files.push(path)
  }
  return files
}

function undeclaredImports(manifest: PackageManifest, distDir: string): Finding[] {
  const allowed = new Set([
    manifest.name,
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ])
  const findings: Finding[] = []
  const seen = new Set<string>()
  for (const declaration of declarationFiles(distDir)) {
    const text = readFileSync(declaration, 'utf8')
    for (const imported of ts.preProcessFile(text, true, true).importedFiles) {
      const specifier = imported.fileName
      if (
        specifier.startsWith('.') ||
        specifier.startsWith('node:') ||
        NODE_BUILTINS.has(specifier) ||
        allowed.has(packageNameFor(specifier))
      ) continue
      const key = `${manifest.name}\u0000${specifier}`
      if (!seen.has(key)) {
        seen.add(key)
        findings.push({ packageName: manifest.name, specifier, declaration })
      }
    }
  }
  return findings
}

function publishedPackages(): Array<{ manifest: PackageManifest; dir: string }> {
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = join(PACKAGES_DIR, entry.name)
      return { manifest: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageManifest, dir }
    })
    // A CHANGELOG is this repository's release anchor: public packages without
    // one (currently comm) have not been published and have no shipped artifact.
    .filter(({ manifest, dir }) => manifest.private !== true && existsSync(join(dir, 'CHANGELOG.md')))
}

describe('shipped declaration dependency gate', () => {
  it('uses TypeScript parsing, so imports mentioned only in comments are ignored', () => {
    const text = [
      "// import type { Decoy } from 'unverifiable'",
      "/* export { Decoy } from 'also-unverifiable' */",
      "import type { Real } from '@fixture/declared'",
    ].join('\n')
    expect(ts.preProcessFile(text, true, true).importedFiles.map((file) => file.fileName)).toEqual([
      '@fixture/declared',
    ])
  })

  it('fails loudly when a published dist directory is absent', () => {
    expect(() => undeclaredImports({ name: '@fixture/missing' }, join(PACKAGES_DIR, 'missing-dist'))).toThrow(
      'published declaration directory is missing',
    )
  })

  it('passes when the imported type is declared as a runtime dependency', () => {
    const manifest = {
      name: '@fixture/consumer',
      dependencies: {
        '@workflow-toolbox/pipeline-spec': '1.0.0',
        '@workflow-toolbox/runtime': '1.0.0',
      },
    }
    const fixtureDist = join(PACKAGES_DIR, 'build/dist')
    const findings = undeclaredImports(manifest, fixtureDist)
    expect(findings).toEqual([])
  })

  it('requires every imported shipped type to be a runtime dependency', () => {
    const packages = publishedPackages()
    expect(packages.map(({ manifest }) => manifest.name).sort()).toEqual([
      '@workflow-toolbox/build',
      '@workflow-toolbox/patterns',
      '@workflow-toolbox/pipeline-spec',
      '@workflow-toolbox/runtime',
      '@workflow-toolbox/std',
    ])

    const findings = packages.flatMap(({ manifest, dir }) => undeclaredImports(manifest, join(dir, 'dist')))
    expect(
      findings,
      'undeclared imports in shipped declarations; add the package to dependencies or stop exposing its type',
    ).toEqual([])
  })
})
