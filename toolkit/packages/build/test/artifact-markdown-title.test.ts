import { describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper shipped by the plugin has no TypeScript declaration
import { markdownTitle } from '../../../../plugin/bin/lib/artifact-markdown-title.mjs'

describe('Markdown title review regressions', () => {
  it.each([
    ['intraword underscores', '# WT_ARTIFACT_SERVER_PORT', 'WT_ARTIFACT_SERVER_PORT'],
    ['release underscores', '# release_v1_final', 'release_v1_final'],
    ['spaced asterisks', '# 2 * 3 * 4', '2 * 3 * 4'],
    ['nested emphasis', '# ***bold***', 'bold'],
    ['image alt text', '# ![Diagram](diagram.png)', 'Diagram'],
    ['balanced destination', '# [guide](https://example.com/a_(b))', 'guide'],
    ['reference link', '# see [guide][g]', 'see guide'],
    ['escaped punctuation', '# \\*literal\\*', '*literal*'],
    ['invalid backtick fence', '```bad`info\n# Actual heading', 'Actual heading'],
    ['CR line endings', 'Intro\r# Actual heading\r', 'Actual heading'],
    ['initial BOM', '\uFEFF# Title', 'Title'],
    ['empty first heading', '#\n# Second heading', 'Second heading'],
    ['closing tilde fence', '~~~\ncode\n~~~\n# Real heading', 'Real heading'],
  ])('handles %s', (_name, source, expected) => {
    expect(markdownTitle(source, 'fallback.md')).toBe(expected)
  })

  it('trims before capping the title', () => {
    expect(markdownTitle(`# \`   ${'a'.repeat(119)}🚀Z   \``, 'fallback.md')).toBe(`${'a'.repeat(119)}🚀`)
  })

  it.each(['*', '`'])('handles ten thousand %s characters within one second', (marker) => {
    const started = performance.now()
    expect(markdownTitle(`# ${marker.repeat(10_000)}`, 'fallback.md')).toBe(marker.repeat(120))
    expect(performance.now() - started).toBeLessThan(1_000)
  })
})
