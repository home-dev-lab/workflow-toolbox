import { readFile } from 'node:fs/promises'
import path from 'node:path'

// Browser URL paths use POSIX separators on every host, including Windows.
export const MERMAID_PATH = '/__wt-artifact-server/mermaid.min.js'

export function readArtifactAsset(file) {
  return readFile(file)
}

export function artifactMermaidRouteIndex(segments) {
  return segments.indexOf(MERMAID_PATH.split('/')[1])
}

export function artifactMermaidRouteMatches(segments, reserved) {
  return segments.length === reserved + 2 && segments[reserved + 1] === path.posix.basename(MERMAID_PATH)
}

export function artifactMermaidScriptSource(depth) {
  return `${'../'.repeat(depth)}${MERMAID_PATH.slice(1)}`
}
