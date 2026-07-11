import { describe, it, expect } from 'vitest'
import { classifyWindowOpen } from '../src/observe-lifecycle.js'

describe('classifyWindowOpen (Electron setWindowOpenHandler policy)', () => {
  it('http/https → externalize to the OS browser, deny the in-app popup', () => {
    expect(classifyWindowOpen('https://github.com/x/y')).toEqual({ action: 'deny', external: 'https://github.com/x/y' })
    expect(classifyWindowOpen('http://127.0.0.1:5174/s/k/api')).toEqual({
      action: 'deny',
      external: 'http://127.0.0.1:5174/s/k/api',
    })
  })

  it('about:blank and blob: → allow an in-app child window (NEVER externalize — the Store-prompt bug)', () => {
    // Regression: shell.openExternal('about:blank' | 'blob:…') pops Windows' Microsoft Store
    // prompt because the OS has no handler for these schemes. The "raw report" flow opens
    // about:blank then navigates it to a blob: of the authenticated report bytes.
    expect(classifyWindowOpen('about:blank')).toEqual({ action: 'allow' })
    expect(classifyWindowOpen('blob:http://127.0.0.1:5174/2a1f-…')).toEqual({ action: 'allow' })
  })

  it('other schemes (javascript:, file:, data:, unparseable) → drop: neither externalize nor allow', () => {
    expect(classifyWindowOpen('javascript:alert(1)')).toEqual({ action: 'deny', external: null })
    expect(classifyWindowOpen('file:///etc/passwd')).toEqual({ action: 'deny', external: null })
    expect(classifyWindowOpen('data:text/html,<script>')).toEqual({ action: 'deny', external: null })
    expect(classifyWindowOpen('not a url')).toEqual({ action: 'deny', external: null })
  })
})
