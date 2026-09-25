import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../packs')
const ignoredDirectories = new Set(['.git', '.lane', 'node_modules', 'build', 'dist'])
const javascriptExtensions = ['.cjs', '.js', '.jsx', '.mjs']
const javascriptRootFiles = ['package.json', 'jsconfig.json', 'tsconfig.json', 'vitest.config.js', 'vitest.config.mjs', 'vitest.config.mts', 'vitest.config.ts']

function packManifests() {
  return fs.readdirSync(packsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(packsRoot, entry.name, 'pack.json'))
    .filter((manifest) => fs.existsSync(manifest))
    .map((manifest) => JSON.parse(fs.readFileSync(manifest, 'utf8')))
}

function sourceFrameworkCounts(root, manifests) {
  const extensions = new Map(manifests.flatMap((manifest) => manifest.triggers.extensions.map((extension) => [extension, manifest.testFramework])))
  for (const extension of javascriptExtensions) extensions.set(extension, 'vitest')
  const counts = new Map()
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()
    let entries
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) pending.push(path.join(directory, entry.name))
      else if (entry.isFile()) {
        const framework = extensions.get(path.extname(entry.name))
        if (framework) counts.set(framework, (counts.get(framework) ?? 0) + 1)
      }
    }
  }
  return counts
}

function ambiguous(frameworks) {
  return `ambiguous:${[...frameworks].sort().join(',')}`
}

function dominantSource(counts) {
  const ranked = [...counts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
  if (ranked.length === 0) return null
  if (ranked.length === 1) return ranked[0][0]
  const otherCount = ranked.slice(1).reduce((total, [, count]) => total + count, 0)
  return ranked[0][1] > 2 * otherCount ? ranked[0][0] : null
}

export function detectFailedTestFramework(root) {
  const manifests = packManifests()
  const fileMatches = new Set(manifests
    .filter((manifest) => manifest.triggers.files?.some((file) => fs.existsSync(path.join(root, file))))
    .map((manifest) => manifest.testFramework))
  if (javascriptRootFiles.some((file) => fs.existsSync(path.join(root, file)))) fileMatches.add('vitest')
  const counts = sourceFrameworkCounts(root, manifests)
  const sourceFramework = dominantSource(counts)
  const frameworks = new Set([...fileMatches, ...counts.keys()])
  if (frameworks.size === 0) return 'undetected'
  if (fileMatches.size > 1) return ambiguous(frameworks)
  if (fileMatches.size === 1) {
    const rootFramework = [...fileMatches][0]
    if (sourceFramework === rootFramework || counts.size === 0) return rootFramework
    return ambiguous(frameworks)
  }
  return sourceFramework ?? ambiguous(frameworks)
}
