import { withRepositoryGuide } from './sdk-role-profile.mjs'

const TOOL_NOTE = 'Tool note: MCP tools (including context-mode) are NOT available in this read-only run; read files with your native shell (cat, sed -n, rg, ls). This overrides any routing rule that says to use context-mode.'

export function originalSecondOpinionRepo(options) {
  return options.originalRepo ?? options.repo
}

export function renderSecondOpinionRequest(repo, request, route) {
  return route === 'opus' ? withRepositoryGuide(repo, request) : `${TOOL_NOTE}\n\n${request}`
}

export function secondOpinionPrompt(options, request, route) {
  return options.requestRendered ? request : renderSecondOpinionRequest(options.repo, request, route)
}
