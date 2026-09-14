# Svelte Components

Keep component state and props typed at their boundary, and verify component behavior with the
project's Vitest setup. Run `svelte-check` when it is configured by the project; it validates Svelte
markup and component type integration that a TypeScript-only check does not cover.

This rule is Svelte-specific. The shared TypeScript family pack owns the generic Vitest TDD and
lint/typecheck/build guidance, so this pack deliberately does not duplicate those rules.
