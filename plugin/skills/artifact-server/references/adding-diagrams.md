# Adding diagrams: recipes and url script checks

This copy-ready command writes an HTML example with one inline Mermaid bundle, one initializer,
and a diagram. Set `CLAUDE_PLUGIN_ROOT` to the installed plugin directory in a normal shell.
The pinned bundle and its MIT license live under `skills/artifact-server/assets/mermaid/`;
if that directory contains placeholders, follow its `VERSION` instructions first.

```bash
node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const bundle = readFileSync(path.join(process.env.CLAUDE_PLUGIN_ROOT,
  'skills/artifact-server/assets/mermaid/mermaid.min.js'), 'utf8')
writeFileSync('diagram.html', `<!-- wt-artifact-server: interactive -->
<!doctype html><html><head><meta charset="utf-8"><title>Report diagram</title></head><body>
<pre class="mermaid">flowchart LR
  Draft --> Review --> Published
</pre>
<script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>
<script>mermaid.initialize({ startOnLoad: true, theme: 'neutral', securityLevel: 'strict' });</script>
</body></html>`)
NODE
```

Instead of inlining the bundle, interactive HTML can load the server's own pinned build:

```html
<script src="__wt-artifact-server/mermaid.min.js"></script>
<script>mermaid.initialize({ startOnLoad: true, theme: 'neutral', securityLevel: 'strict' });</script>
```

This document-relative bundle URL works from any page depth, including nested report directories:
the server recognizes its reserved segment at any depth.

For `.html` and `.htm` targets, `wt-artifact-server url` checks for scripts/imports the page's mode
blocks before printing a link, even without `--check`. Any finding refuses the URL with exit 6:
stdout stays empty and `--check` does not run. Stderr names the page, its mode (or absence of a
marker), and the blocked kinds and counts. A Mermaid class adds a source-text hint.

For a trusted page you authored, put `<!-- wt-artifact-server: interactive -->` on its first line.
Interactive pages with blocked cross-origin scripts or imports must self-host them under a
registered root instead; the bundled Mermaid path above works without a CDN. A marker alone does
not admit a CDN loader. There is no automatic mode change, and serving policies stay the same.

If the page is deliberately locked, re-run the same command with `--allow-locked`. It prints the
URL alone on stdout and keeps the existing warnings on stderr, before any `--check` result;
the warnings do not change the exit code. Markdown and all other non-HTML targets are never
refused by this check. An unreadable HTML file retains ordinary URL resolution without a refusal.

The check is best-effort page-text detection, not a browser: the CSP header the server sends decides
what runs. It does not resolve character references in URLs, import maps, or comments inside
`import()`, and it treats scripts inside `<template>` as live, so a page can still be blocked
without a finding, or refused for code that never runs. Use `--allow-locked` for a deliberate exception.
