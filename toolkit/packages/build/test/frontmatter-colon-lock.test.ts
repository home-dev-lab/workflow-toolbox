import { expect, it } from 'vitest'
// @ts-expect-error plugin runtime modules are untyped JavaScript.
import { parseFrontmatter } from '../../../../plugin/bin/lib/frontmatter.mjs'

it.each([
  ['colon-space extension', 'description: Triggers include: X, Y', true, true, 'Triggers include: X, Y'],
  ['quoted value', 'description: "Triggers include: X, Y"', true, false, 'Triggers include: X, Y'],
  ['indented continuation', 'description: Triggers include: X\n  continued', false, undefined, undefined],
  ['dash indicator', 'description: - Read: Write', false, undefined, undefined],
  ['bracket indicator', 'description: [Read: Write]', true, false, [{ Read: 'Write' }]],
  ['anchor indicator', 'description: &label Read: Write', false, undefined, undefined],
  ['single-quote indicator', "description: 'Read: Write'", true, false, 'Read: Write'],
  ['control character', 'description: Read\x01: Write', false, undefined, undefined],
  ['trailing comment', 'description: Triggers include: X # comment', true, true, 'Triggers include: X'],
  ['comment kept when a line separator follows it', 'description: Triggers include: X # c ', true, true, 'Triggers include: X # c'],
  ['comment kept when a paragraph separator follows it', 'description: Triggers include: X # c ', true, true, 'Triggers include: X # c'],
  ['indented child key','metadata:\n  description: Triggers include: X', false, undefined, undefined],
] as const)('%s', (_label, block, ok, extension, value) => {
  const result = parseFrontmatter(`---\n${block}\n---\n`)
  expect(result.ok).toBe(ok)
  if (ok) {
    expect(result.extension).toBe(extension)
    expect(result.data.description).toEqual(value)
  } else expect(result.reason).toBe('malformed')
})
