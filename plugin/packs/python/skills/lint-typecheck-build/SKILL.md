---
name: lint-typecheck-build
description: Run the Python project's Ruff, Pyright, and build or packaging gates and report their exit codes.
---

# Python Gate Sequence

Run the project's documented commands in this order:

| Gate | Command |
| --- | --- |
| Lint | `ruff check .` |
| Typecheck | `pyright` |
| Build or package | The project's documented build or packaging command |

Use the project's package-manager choice to invoke these commands. pip, uv, and poetry are common
choices; the project's own choice wins. For each command, record its exit code before advancing to
command timeout. Report a table with the command, exit code, and whether the marker was observed.
Do not report a partial log as a gate result.

Adapted from ECC, `plugin/agents/python-build-resolver.md`.
