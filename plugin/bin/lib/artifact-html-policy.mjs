// Content-Security-Policy headers for files the artifact server sends unchanged. HTML picks its policy from an
// optional first-content marker; every other file type keeps RAW_CSP.
export const RAW_CSP = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'"
// Unmarked HTML runs no page script, but its sandbox allows scripts: a sandbox without allow-scripts also stops
// the browser's own injected tools (Orca's annotation arms through webContents.executeJavaScript), whereas CSP
// script-src 'none' blocks every page script, handler and javascript: URL while leaving that injection alone.
// The opaque origin and the sandbox's popup, download, form and top-navigation restrictions stay. allow-scripts
// also lifts the automatic-features restriction, so a meta refresh or autofocus now works, and <noscript>
// content is hidden.
const DEFAULT_HTML_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'"
const RICH_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; img-src data:; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'"
const ANNOTATABLE_CSP = "default-src 'none'; script-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
const INTERACTIVE_CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'"

// Every HTML mode, the unmarked default included, keyed by its marker name ('default' has no marker).
/** @knipTestSeam Imported by toolkit/packages/build/test/artifact-server-csp.selftest.mjs. */
export const HTML_PAGE_POLICIES = new Map([
  ['default', DEFAULT_HTML_CSP], ['rich', RICH_CSP], ['annotatable', ANNOTATABLE_CSP], ['interactive', INTERACTIVE_CSP],
])

export function htmlPagePolicy(file) {
  const mode = /^\s*<!--\s*wt-artifact-server:\s*(rich|annotatable|interactive)\s*-->/i.exec(file.toString('utf8', 0, 256))?.[1].toLowerCase()
  return HTML_PAGE_POLICIES.get(mode ?? 'default')
}
