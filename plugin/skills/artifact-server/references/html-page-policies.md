# HTML page policies and the annotation marker

Moved word for word from the "Serving security" section of SKILL.md.

- Markdown raw HTML is escaped. `.txt`, `.log`, and `.json` are escaped. HTML is unchanged and,
  by default, runs no page script: its policy, `sandbox allow-scripts` with `script-src 'none'`,
  keeps the opaque origin and the sandbox's limits on popups, downloads, forms, and navigating
  other windows, while CSP blocks every inline script, event handler, and `javascript:` URL. The
  sandbox admits scripts only so that the browser's own injected tools can run: Orca's annotation
  arms itself by injecting a script, which a sandbox without `allow-scripts` refuses, so no HTML
  mode needs a marker for that injection. Enabling scripting for the document also lets a
  `<meta http-equiv="refresh">` navigate the page by itself, possibly to a marked page whose
  scripts run, lets `autofocus` take focus, and hides `<noscript>` content: `allow-scripts` lifts
  the sandbox's automatic-features restriction together with its script restriction. An HTML file whose first non-whitespace content is the
  visible `<!-- wt-artifact-server: rich -->` marker opts into inline scripts, still without
  same-origin authority, network connections, or external images. The marker travels inside the
  file; an extension can be lost on rename, while a sibling policy file can drift away. Rich mode
  narrows blast radius but does not make the artifact trusted: opening it still runs unreviewed code
  the owner chose to open. Raw SVG and unknown content retain the no-script sandbox; generated
  Markdown without Mermaid fences and indexes use a strict no-script CSP.
- The `<!-- wt-artifact-server: annotatable -->` marker is no longer needed for annotation, and
  existing pages that carry it keep working. Placed before any non-whitespace content, like the
  rich marker it is case-insensitive and must fit entirely within the first 256 bytes. Annotatable
  mode serves the document on the server's real origin (no CSP sandbox) and never runs page
  scripts: `script-src 'none'` blocks them. Network
  connections, forms, base-URL changes, and framing are blocked; inline styles and same-origin
  or data images are allowed. For script-free expand/collapse interactivity, use native
  `<details><summary>More</summary>...</details>` elements. This mode does not enable rich scripts.
