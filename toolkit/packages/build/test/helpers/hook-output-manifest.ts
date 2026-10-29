import type { Justifications, ScanResult } from './hook-output-scan.js'

interface HookManifest { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> }

function registerCommand(command: string, event: string, files: Set<string>, exceptions: Justifications, result: ScanResult) {
  // Only a direct plugin-root executable is statically covered. Shell/inline forms need a proof.
  const match = /^(?:[\w./-]+\s+)?(["']?)\$\{CLAUDE_PLUGIN_ROOT\}\/([^"'\s]+)\1\s*$/.exec(command)
  const file = match?.[2]
  const supported = file && /\.(?:mjs|js|cjs)$/.test(file)
  if (supported && files.has(file)) return file
  const key = `.claude-plugin/plugin.json:${event}:${command}`
  const entry = exceptions.get(key)
  if (entry?.reason.trim() && typeof entry.prove === 'function') result.justified.add(key)
  else if (file && !supported) result.problems.push(`${file}: registered hook executable type is unsupported`)
  else result.problems.push(`${key}: registered hook command cannot resolve to a scanned source file; requires a reason and serialized-output contract proof`)
  return undefined
}

export function scanManifest(manifest: HookManifest, files: Set<string>, exceptions: Justifications = new Map()) {
  const registrations = new Map<string, Set<string>>()
  const result: ScanResult = { emissions: 0, problems: [], justified: new Set() }
  for (const [event, groups] of Object.entries(manifest.hooks ?? {})) {
    for (const group of groups) {
      for (const hook of group.hooks ?? []) {
        const file = registerCommand(hook.command ?? '', event, files, exceptions, result)
        if (!file) continue
        const events = registrations.get(file) ?? new Set<string>()
        events.add(event)
        registrations.set(file, events)
      }
    }
  }
  return { registrations, result }
}
