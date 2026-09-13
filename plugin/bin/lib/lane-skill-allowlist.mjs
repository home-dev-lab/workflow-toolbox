// These skills can mutate shared memory or a board; lanes must remain single-writer safe.
// save-memory, planka-tracking/SKILL.md, and what-next/SKILL.md are their respective writers.
export const REFUSED_LANE_SKILLS = Object.freeze(['save-memory', 'planka-tracking', 'what-next'])

const NAME = /^[a-z0-9][a-z0-9._-]*$/

export function resolveLaneSkillAllowlist({ env = process.env } = {}) {
  const value = typeof env.WT_LANE_SKILLS === 'string' ? env.WT_LANE_SKILLS.trim() : ''
  if (!value) return { allowed: [], refusals: [] }
  const allowed = []
  const refusals = []
  const seen = new Set()
  for (const name of value.split(/[\s,]+/)) {
    if (!name || seen.has(name)) continue
    seen.add(name)
    if (!NAME.test(name) || name.includes('..')) {
      refusals.push({ name, reason: `invalid skill name: ${name}` })
    } else if (REFUSED_LANE_SKILLS.includes(name)) {
      refusals.push({ name, reason: `${name} is a single-writer memory/board-writing skill` })
    } else {
      allowed.push(name)
    }
  }
  return { allowed, refusals }
}
