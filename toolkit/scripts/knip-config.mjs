import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { eslintIgnorePatterns, listGitIgnoredPaths } from './git-ignored-inputs.mjs'

const root = resolve(import.meta.dirname, '../..')
const file = resolve(root, 'knip.json')
const { config, error } = ts.parseConfigFileTextToJson(file, readFileSync(file, 'utf8'))
if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'))
const ignored = eslintIgnorePatterns(listGitIgnoredPaths(root).paths, root, [root])
  .map((path) => path.endsWith('/') ? `${path}**` : path)

export default { ...config, ignore: [...(config.ignore ?? []), ...ignored] }
