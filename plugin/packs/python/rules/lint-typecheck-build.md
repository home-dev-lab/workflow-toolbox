# Python Lint, Typecheck, and Build

Run the project's Ruff lint, Pyright typecheck, and build or packaging command in the order the
project documents. The project's package-manager choice wins; pip, uv, and poetry are common
choices, not a replacement for its documented commands.

Treat a gate as green only when its process exits with code `0`. For long-running gates, run the
command detached with a log and an appended exit marker, then poll until the marker is present.
Do not infer success from partial output or a log that lacks an exit code.

Use `ruff check .` for linting and `pyright` for typechecking unless the project documents a more
specific target. Run its build or packaging command after both checks.

Adapted from ECC, `plugin/agents/python-build-resolver.md`.
