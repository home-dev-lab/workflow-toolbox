#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../packages/build/package.json', import.meta.url))
const { build } = require('esbuild')
const version = require('./package.json').devDependencies.yaml
const license = fs.readFileSync(path.join(path.dirname(require.resolve('yaml/package.json')), 'LICENSE'), 'utf8')
const entry = path.join(path.dirname(require.resolve('yaml/package.json')), 'browser/index.js')
const result = await build({ absWorkingDir: path.resolve(import.meta.dirname, '..'), stdin: { contents: `export { parse } from ${JSON.stringify(entry)}`, resolveDir: import.meta.dirname }, bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' })
const output = `// generated from yaml@${version} by toolkit/scripts/vendor-yaml.mjs\n/*\n${license.trimEnd()}\n*/\n${result.outputFiles[0].text}`
const destination = path.resolve(import.meta.dirname, '../../plugin/bin/lib/vendor/yaml.mjs')
if (process.argv.includes('--check')) {
  if (fs.readFileSync(destination, 'utf8') !== output) { console.error('vendored yaml differs'); process.exitCode = 1 }
} else fs.writeFileSync(destination, output)
