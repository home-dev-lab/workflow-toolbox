#!/usr/bin/env node
// Reproducible source census for the host/lane trust boundary. Run from toolkit:
// node scripts/lane-host-census.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../plugin/', import.meta.url))
const locations = ['bin', 'hooks', 'skills']
const operation = /\b(?:readFileSync|writeFileSync|appendFileSync|openSync|statSync|lstatSync|readdirSync|realpathSync|mkdirSync|rmSync|cpSync|copyFileSync|readWorktreeRegular|readRegularFile|readRecord|readLogTail|writeRegularFile|writeJsonAtomic|copy|spawnSync|execFileSync|writeFile|readJson|runLogged)\s*\(/
const displayRead = /(?:^|[^\w.])(?:list|info|tail|head|slice)\s*\(/
const boundary = /(?:\.lane|worktree|laneDir|lanePath|supervision|run\.log|brief-snapshots|runtimeDir|stateRoot)/i

function files(directory) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) return files(file)
    return /\.(?:mjs|js)$/.test(entry.name) ? [file] : []
  })
}

const rows = locations.flatMap((name) => files(path.join(root, name)))
  .filter((file) => !file.includes(`${path.sep}skills${path.sep}`) || file.includes(`${path.sep}scripts${path.sep}`))
  .flatMap((file) => fs.readFileSync(file, 'utf8').split('\n').flatMap((line, index) => {
    if (/^\s*(?:\/\/|\*|#)/.test(line) || (!operation.test(line) && !displayRead.test(line)) || !boundary.test(line)) return []
    return [{ file: path.relative(root, file), line: index + 1, source: line.trim().slice(0, 180) }]
  }))

process.stdout.write(`candidate_sites=${rows.length} (search aid; not an audited I/O inventory)\n| Candidate site | Source |\n| --- | --- |\n`)
for (const row of rows) process.stdout.write(`| ${row.file}:${row.line} | ${row.source.replaceAll('|', '\\|').replaceAll('`', '\\`')} |\n`)
