import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const DEFAULT_SKILL_SIZE_WARN_CHARS = 8000

export function skillSizeThreshold(env = process.env) {
  const value = env.WT_SKILL_SIZE_WARN_CHARS?.trim() ?? ''
  const number = Number(value)
  return /^\d+$/.test(value) && Number.isSafeInteger(number)
    ? number : DEFAULT_SKILL_SIZE_WARN_CHARS
}

function bodyCharacters(file) {
  try {
    // Do not follow linked bodies or read streams/devices. Authoring-time only:
    // this is not a concurrent-replacement security boundary or a runtime hook.
    if (!lstatSync(file).isFile()) return null
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  let characters = 0
  for (const _character of readFileSync(file, 'utf8')) characters++
  return characters
}

export function oversizedSkills(skillsDir, env = process.env) {
  const threshold = skillSizeThreshold(env)
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()) // skip symlinked directories/junctions
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const characters = bodyCharacters(join(skillsDir, entry.name, 'SKILL.md'))
      return characters !== null && characters > threshold
        ? [{ name: entry.name, characters, threshold }] : []
    })
}

export function reportSkillSizes(skillsDir, print = console.log, env = process.env) {
  // Report-only: multiple shipped bodies already exceed 8000. Keep visibility in
  // normal gates without making the existing tree fail before content is trimmed.
  for (const { name, characters, threshold } of oversizedSkills(skillsDir, env)) {
    print(`SKILL SIZE: ${name}: ${characters} characters (threshold ${threshold}). ` +
      'Move sections to references/; keep the body short. Invoked bodies are re-injected after every compaction.')
  }
  return 0
}
