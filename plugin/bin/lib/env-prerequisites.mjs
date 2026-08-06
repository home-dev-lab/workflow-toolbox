// env-prerequisites.mjs — the DETECTION side's declaration of the environment settings
// the adopted sets require, plus the three-state reader and the drift evaluator built
// on it.
//
// ⚠ THIS LIST HAS A TWIN, and the duplication is deliberate. `adopt`
// (plugin/skills/adopt/scripts/install.mjs) REPAIRS a missing prerequisite; this module
// backs the SessionStart hook that DETECTS one which drifted afterwards. Two mechanisms,
// one fact — so the obvious move is for the installer to import from here.
//
// It cannot. The installer must stay a single relocatable file: its own tests copy it
// alone into a synthetic plugin root, and a runtime import of a sibling module breaks it
// by construction (measured — ERR_MODULE_NOT_FOUND across six test files). That
// self-containment is load-bearing, not incidental.
//
// What keeps the two copies honest is therefore a TEST, not an import:
// toolkit/packages/build/test/env-prerequisite-drift-hook.test.ts parses BOTH files as
// text and asserts the declarations are identical. Add a requirement to one and it goes
// red naming the other — which is the point, because the failure it prevents is the
// detector going quiet about a requirement only the installer knows, and that silence is
// indistinguishable from "nothing has drifted".
//
// ⚠ NOTHING here ever reads or returns an environment VALUE. The `env` block of a
// settings file carries real credentials on this machine and on adopters' machines;
// a probe that prints one has leaked it into a transcript that is sent to a model and
// stored durably. Every function below works on KEY NAMES only, and the shape of the
// return types is what enforces that — there is no field a value could travel in.

/** Required wherever any managed set is adopted. */
export const UNIVERSAL_ENV_REQUIREMENTS = [
  {
    key: 'CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH',
    value: '3',
    sets: ['rules', 'agents'],
    /** What actually breaks, in the reader's terms — never "the key is missing". */
    consequence:
      'the nested-spawn ceiling can sit below the pilot suite\'s three levels, so an executor lane dies mid-wave with no error naming the cause',
  },
]

/** Required ONLY where the agents set is adopted. A project that adopted rules alone
 *  does not need this, and warning it there would be firing on a correct state — the
 *  single case that decides whether a session-start check survives its first week. */
export const AGENT_ONLY_ENV_REQUIREMENTS = [
  {
    key: 'CLAUDE_CODE_EXPERIMENTAL_OBSERVER_AGENTS',
    value: '1',
    sets: ['agents'],
    consequence:
      'adopted pilots run WITHOUT their paired watchdog, and their own reports then honestly say "no observer findings" — an absence that reads exactly like a clean run',
  },
]

/** The requirements that apply to a given set of adopted set-names. */
export function requirementsFor(adoptedSets) {
  const names = new Set(adoptedSets)
  return [...UNIVERSAL_ENV_REQUIREMENTS, ...AGENT_ONLY_ENV_REQUIREMENTS].filter((req) =>
    req.sets.some((set) => names.has(set)),
  )
}

/** Three states, never a boolean — `unknown` is a first-class outcome and must never
 *  be folded into `absent`. A probe that cannot read the file and says "it is broken"
 *  is how a check earns a reputation for crying wolf, and a check nobody believes is
 *  worse than no check.
 *
 *  Returns `{ state: 'ok', keys: string[] }` — key NAMES only, values discarded at the
 *  boundary — or `{ state: 'unknown', reason: string }`. A settings file with no `env`
 *  block at all is `ok` with zero keys: the file was read, and the block's absence is a
 *  measurement, not a failure to measure.
 *
 *  `readFile` is injected so the caller's tests exercise every branch without a
 *  filesystem; it must throw on an unreadable path, exactly as `fs.readFileSync` does. */
export function readEnvKeys(settingsPath, readFile) {
  let raw
  try {
    raw = readFile(settingsPath)
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null
    // A file that is not there is NOT the same as a file that cannot be read. Neither
    // is "absent" — a settings file may legitimately not exist yet, and that tells us
    // nothing about whether a key drifted out of it.
    if (code === 'ENOENT') return { state: 'unknown', reason: 'no settings file at that path' }
    return { state: 'unknown', reason: 'settings file could not be read' }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { state: 'unknown', reason: 'settings file is not valid JSON' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { state: 'unknown', reason: 'settings root is not a JSON object' }
  }
  const env = parsed['env']
  if (env === undefined) return { state: 'ok', keys: [] }
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    return { state: 'unknown', reason: 'settings "env" is present but is not an object' }
  }
  // Object.keys, never Object.entries: the values are credentials and must not travel
  // one line further than this.
  return { state: 'ok', keys: Object.keys(env) }
}

/** Decide what to say, if anything.
 *
 *  Returns `{ verdict: 'silent' }`, `{ verdict: 'unknown', reason }`, or
 *  `{ verdict: 'drift', missing: [{ key, value, consequence }] }`.
 *
 *  `silent` covers BOTH happy paths and they are different facts: every requirement is
 *  satisfied, or nothing was adopted so nothing is required. Collapsing them would be
 *  harmless here and is deliberately avoided anyway — a caller that wants to explain
 *  itself needs to know which one it hit. */
export function evaluateEnvDrift({ adoptedSets, envState }) {
  const required = requirementsFor(adoptedSets)
  // Nothing adopted (or nothing required) → silent even when the env block is
  // unreadable. There is no prerequisite to have drifted, so there is nothing an
  // UNKNOWN could be hiding, and speaking here would be noise on a correct state.
  if (required.length === 0) return { verdict: 'silent', because: 'no managed set is adopted here' }
  if (envState.state === 'unknown') return { verdict: 'unknown', reason: envState.reason }

  const present = new Set(envState.keys)
  const missing = required
    .filter((req) => !present.has(req.key))
    .map((req) => ({ key: req.key, value: req.value, consequence: req.consequence }))

  if (missing.length === 0) return { verdict: 'silent', because: 'every prerequisite is present' }
  return { verdict: 'drift', missing }
}
