import { describe, expect, it } from 'vitest'
import { renderParityTable } from '../../../scripts/lsp-parity-table.mjs'

describe('LSP parity table', () => {
  it('renders missing arms as unmeasured rather than blank cells', () => {
    const { markdown } = renderParityTable({ typescript: { references: { verdict: 'parity' } } }, ['typescript', 'python'])
    expect(markdown).toContain('| references | parity | unmeasured (no archive) |')
    expect(markdown.split('\n').filter(Boolean)).not.toContain('| references | parity |  |')
  })
})
