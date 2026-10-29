import fs from 'node:fs'

process.stdout.on('error', () => {})
process.on('uncaughtException', () => process.exit(0))
process.on('unhandledRejection', () => process.exit(0))

async function main() {
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8'))
    if (input?.hook_event_name !== 'PreToolUse') return
    const { scanHookInput, warningContext } = await import('./redaction-token-scan.mjs')
    const result = scanHookInput(input)
    if (result.exempt || !result.total) return
    const additionalContext = warningContext(input.tool_name, result)
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext } }) + '\n')
  } catch { /* Best-effort warning, including unavailable dependencies. */ }
}

await main()
