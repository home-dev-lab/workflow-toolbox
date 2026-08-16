// prior-art-launch-guard-core.mjs — pure logic behind
// wt-prior-art-launch-guard-hook.mjs: does this Bash command LAUNCH a run,
// what keywords does it carry, and which indexed card titles look related.
// Kept separate from the hook so a test can drive matching without spawning
// a process or touching the filesystem.

export const MAX_MATCHES = 5

// A `wt-observe … launch …` invocation, in any position within a longer
// pipeline (`cd x && wt-observe launch foo.js`). Deliberately narrow to the
// two documented launch surfaces named by the card this guard answers —
// broadening the match set is a judgment call for a future pass, not
// something this regex should silently attempt.
const WT_OBSERVE_LAUNCH = /\bwt-observe(?:\.mjs)?\b[^\n|;&]*\blaunch\b/
const CURL_PIPELINE_API = /\bcurl\b[^\n]*\/api\/(pipeline|scripted-run)\b/

export function matchLaunchCommand(cmd) {
  return WT_OBSERVE_LAUNCH.test(cmd) || CURL_PIPELINE_API.test(cmd)
}

// Splits a token on non-alphanumeric boundaries into lowercase words of at
// least 3 characters — long enough to carry meaning, short enough that a
// two-word workflow name ("pr-review") still yields both "pr" [dropped,
// too short] and "review".
function wordsFrom(token) {
  return String(token || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((w) => w.length >= 3)
}

/**
 * Derives keyword tokens from a launch command's TEXT — never from a board
 * card, never from prior state. Purely a function of the command string, so
 * the same command always yields the same keywords.
 *
 * @param {string} cmd
 * @returns {string[]} lowercase keywords, deduplicated, order-preserving.
 */
export function deriveKeywords(cmd) {
  const keywords = new Set()

  const launchArg = /\blaunch\s+([^\s'"]+)/.exec(cmd)
  if (launchArg) {
    const raw = launchArg[1]
    const basename = raw.split(/[\\/]/).pop() || raw
    const stem = basename.replace(/\.(js|mjs|ts)$/i, '')
    for (const w of wordsFrom(stem)) keywords.add(w)
    if (stem.length >= 3) keywords.add(stem.toLowerCase())
  }

  if (/\/api\/pipeline\b/.test(cmd)) keywords.add('pipeline')
  if (/\/api\/scripted-run\b/.test(cmd)) {
    keywords.add('scripted')
    keywords.add('scripted-run')
  }

  // A few free-text hints worth carrying whenever the command literally
  // names them — cheap, and exactly the vocabulary the memory note's own
  // field case used ("scripted", "pipeline", "mixed").
  for (const hint of ['scripted', 'pipeline', 'mixed', 'workflow']) {
    if (cmd.toLowerCase().includes(hint)) keywords.add(hint)
  }

  return [...keywords]
}

/**
 * @param {Array<{id:string,name:string,listName:string}>} cards
 * @param {string[]} keywords
 * @returns {Array<{id:string,name:string,listName:string}>} cards whose name
 *   contains at least one keyword, case-insensitively, in index order.
 */
export function matchCards(cards, keywords) {
  const list = Array.isArray(cards) ? cards : []
  const kws = (Array.isArray(keywords) ? keywords : []).filter(Boolean)
  if (kws.length === 0) return []
  return list.filter((c) => {
    const name = String(c?.name || '').toLowerCase()
    return kws.some((kw) => name.includes(kw))
  })
}
