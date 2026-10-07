import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { escapeGlob, listGitIgnoredPaths } from './git-ignored-inputs.mjs'

const root = resolve(import.meta.dirname, '../..')
const file = resolve(root, 'knip.json')
const { config, error } = ts.parseConfigFileTextToJson(file, readFileSync(file, 'utf8'))
if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'))

function workspaceNegations(paths, workspace) {
  const prefix = workspace === '.' ? '' : `${workspace}/`
  return paths.filter((path) => path.startsWith(prefix)).map((path) => {
    const local = path.slice(prefix.length)
    return `!${escapeGlob(local)}${path.endsWith('/') ? '**' : ''}`
  })
}

export function knipConfigWithIgnored(config, ignoredPaths) {
  const workspaces = Object.entries(config.workspaces ?? {}).map(([name, workspace]) => {
    const negations = workspaceNegations(ignoredPaths, name)
    if (!negations.length) return [name, workspace]
    return [name, { ...workspace,
      entry: [...(workspace.entry ?? []), ...negations],
      project: [...(workspace.project ?? []), ...negations],
    }]
  })
  return { ...config, workspaces: Object.fromEntries(workspaces) }
}

export default knipConfigWithIgnored(config, listGitIgnoredPaths(root).paths)
