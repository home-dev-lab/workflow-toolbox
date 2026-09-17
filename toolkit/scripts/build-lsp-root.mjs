import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'

const TOOLKIT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_REPO_ROOT = resolve(TOOLKIT_DIR, '..')

export function topLevelKeys(text, file) {
  const keys = []
  let depth = 0
  let index = 0

  while (index < text.length) {
    const character = text[index]
    if (character === '"') {
      const start = index
      index += 1
      let escaped = false
      while (index < text.length) {
        const current = text[index]
        if (!escaped && current === '"') break
        escaped = !escaped && current === '\\'
        if (current !== '\\') escaped = false
        index += 1
      }
      if (index >= text.length) throw new Error(`${file}: unterminated JSON string`)

      if (depth === 1) {
        let next = index + 1
        while (/\s/.test(text[next] ?? '')) next += 1
        if (text[next] === ':') {
          try {
            keys.push(JSON.parse(text.slice(start, index + 1)))
          } catch {
            throw new Error(`${file}: invalid top-level JSON key`)
          }
        }
      }
      index += 1
      continue
    }
    if (character === '{' || character === '[') depth += 1
    if (character === '}' || character === ']') depth -= 1
    index += 1
  }

  return keys
}

function validateDeclaration(declaration, file, key) {
  const label = `${file}: declaration ${JSON.stringify(key)}`
  if (typeof declaration !== 'object' || declaration === null || Array.isArray(declaration)) {
    throw new Error(`${label} must be an object`)
  }
  if (typeof declaration.command !== 'string') throw new Error(`${label} field command must be a string`)
  if (/[\\/]/.test(declaration.command)) throw new Error(`${label} field command must be a bare executable name resolved on PATH, not a path`)
  if (!Array.isArray(declaration.args)) throw new Error(`${label} field args must be an array`)
  if (
    typeof declaration.extensionToLanguage !== 'object' ||
    declaration.extensionToLanguage === null ||
    Array.isArray(declaration.extensionToLanguage)
  ) {
    throw new Error(`${label} field extensionToLanguage must be an object`)
  }
  if (declaration.diagnostics !== true) throw new Error(`${label} field diagnostics must be exactly true`)
}

export function packLspPaths(repoRoot = DEFAULT_REPO_ROOT) {
  const packsDir = join(repoRoot, 'plugin', 'packs')
  return readdirSync(packsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, file: join(packsDir, entry.name, '.lsp.json') }))
    .filter(({ file }) => {
      try {
        readFileSync(file)
        return true
      } catch (error) {
        if (error?.code === 'ENOENT') return false
        throw error
      }
    })
    .sort((left, right) => {
      if (left.name === 'typescript') return -1
      if (right.name === 'typescript') return 1
      return left.name.localeCompare(right.name)
    })
}

export function buildLspRoot(repoRoot = DEFAULT_REPO_ROOT) {
  const merged = {}
  const seen = new Map()

  for (const { file } of packLspPaths(repoRoot)) {
    const relativeFile = file.slice(repoRoot.length + 1).replaceAll('\\', '/')
    const text = readFileSync(file, 'utf8')
    const keys = topLevelKeys(text, relativeFile)
    for (const key of keys) {
      if (seen.has(key)) {
        throw new Error(`${relativeFile}: duplicate declaration key ${JSON.stringify(key)} (first seen in ${seen.get(key)})`)
      }
      seen.set(key, relativeFile)
    }

    let declarations
    try {
      declarations = JSON.parse(text)
    } catch (error) {
      throw new Error(`${relativeFile}: invalid JSON: ${error.message}`)
    }
    if (typeof declarations !== 'object' || declarations === null || Array.isArray(declarations)) {
      throw new Error(`${relativeFile}: root must be an object`)
    }
    for (const key of keys) {
      validateDeclaration(declarations[key], relativeFile, key)
      merged[key] = declarations[key]
    }
  }

  return `${JSON.stringify(merged, null, 2)}\n`
}

export function writeLspRoot(repoRoot = DEFAULT_REPO_ROOT) {
  writeFileSync(join(repoRoot, 'plugin', '.lsp.json'), buildLspRoot(repoRoot))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    writeLspRoot()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
