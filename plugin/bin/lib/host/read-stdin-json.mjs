import { readFileSync } from 'node:fs'

export function readStdinJson() {
  try {
    return JSON.parse(readFileSync(0, 'utf8')) || {}
  } catch {
    return {}
  }
}
