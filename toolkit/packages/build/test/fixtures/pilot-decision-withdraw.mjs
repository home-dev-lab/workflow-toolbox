import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const link = fs.linkSync
fs.linkSync = (...args) => {
  link(...args)
  const path = process.env.WT_DECISION_WITHDRAW_REQUEST
  const request = JSON.parse(fs.readFileSync(path, 'utf8'))
  fs.writeFileSync(path, JSON.stringify({ ...request, criteria: [] }))
}
syncBuiltinESMExports()
