# SDLC engineering protocol — at act

## Implement and verify

Run the applicable build, type, lint, format, test, integration, static-analysis, and end-to-end
checks. Record each by exit code. Never claim a check passed unless it ran; an unrunnable check
remains explicitly unresolved. Warnings introduced by the change are failures unless justified.
