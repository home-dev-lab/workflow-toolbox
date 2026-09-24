import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../packs')

function packManifests() {
  return fs.readdirSync(packsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(packsRoot, entry.name, 'pack.json'))
    .filter((manifest) => fs.existsSync(manifest))
    .map((manifest) => JSON.parse(fs.readFileSync(manifest, 'utf8')))
}

function sourceFrameworkCounts(root, manifests) {
  const extensions = new Map(manifests.flatMap((manifest) => manifest.triggers.extensions.map((extension) => [extension, manifest.testFramework])))
  const counts = new Map()
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !['.git', '.lane', 'node_modules', 'build', 'dist'].includes(entry.name)) pending.push(path.join(directory, entry.name))
      else if (entry.isFile()) {
        const framework = extensions.get(path.extname(entry.name))
        if (framework) counts.set(framework, (counts.get(framework) ?? 0) + 1)
      }
    }
  }
  return counts
}

export function detectFailedTestFramework(root) {
  const manifests = packManifests()
  const fileMatches = new Set(manifests
    .filter((manifest) => manifest.triggers.files?.some((file) => fs.existsSync(path.join(root, file))))
    .map((manifest) => manifest.testFramework))
  if (fileMatches.size === 1) return [...fileMatches][0]
  if (fileMatches.size > 1) return `ambiguous:${[...fileMatches].sort().join(',')}`
  const counts = [...sourceFrameworkCounts(root, manifests)].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
  if (counts.length === 0) return 'vitest'
  if (counts[1]?.[1] === counts[0][1]) return `ambiguous:${counts.filter(([, count]) => count === counts[0][1]).map(([framework]) => framework).join(',')}`
  return counts[0][0]
}
