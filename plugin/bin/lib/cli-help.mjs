// cli-help.mjs — the ONE convention every operator-facing wt-* CLI uses for --help/-h.
//
// Why this exists: `--help` used to be an ordinary unknown flag on most of these scripts,
// refused with exit 2 exactly like a typo. That is the wrong answer to the single most
// common thing anyone types at an unfamiliar binary, and it makes a wrapper that probes
// availability with `--help` conclude the tool is broken.
//
// This must be checked BEFORE any other argument parsing (including a paired --flag value
// loop) — `--help` never takes a value and never participates in "unknown flag" refusal.
// A CLI calls this once, at the very top of its arg handling, with its own usage text.
export function handleHelpFlag(argv, helpText) {
  if (argv.includes('--help') || argv.includes('-h')) {
    const text = helpText.endsWith('\n') ? helpText : `${helpText}\n`
    process.stdout.write(text)
    process.exit(0)
  }
}
