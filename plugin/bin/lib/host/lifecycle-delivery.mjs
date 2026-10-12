// Host operations used by lifecycle delivery policy; preserve synchronous ordering and errors.
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

export const lifecycleDeliveryHost = {
  git: execFileSync,
  stat: (file) => fs.lstatSync(file, { bigint: true }),
  readText: (file) => fs.readFileSync(file, 'utf8'),
  remove: (file) => fs.rmSync(file, { force: true }),
  append: (file, text) => fs.appendFileSync(file, text),
}
