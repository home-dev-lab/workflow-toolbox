# Adding diagrams: recipes and url warnings

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

For HTML targets, `wt-artifact-server url` warns on stderr when textual script/import detection
finds code the page's mode blocks. Each warning names the mode, blocked kind and count, and the
interactive marker (or rich for inline-only scripts). Interactive pages with blocked external URLs
are directed to self-host scripts under a registered root. A Mermaid class adds a source-text hint.
Warnings precede `--check` output, leave stdout as the URL alone, and never change the exit code.
Markdown and other non-HTML targets do not produce these warnings.

The check is advice read from the page text, not a browser: the CSP header the server sends decides
what runs. It does not resolve character references in URLs, import maps, or comments inside
`import()`, and it treats scripts inside `<template>` as live, so a page can still be blocked
without a warning, or warned about code that never runs.
