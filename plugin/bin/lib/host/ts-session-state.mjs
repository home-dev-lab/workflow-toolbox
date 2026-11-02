function offset(text, position) {
  let start = 0
  for (let line = 0; line < position.line; line++) {
    const end = text.indexOf('\n', start)
    if (end < 0) return text.length
    start = end + 1
  }
  const end = text.indexOf('\n', start)
  return Math.min(start + position.character, end < 0 ? text.length : end)
}

function changeDocument(document, params) {
  let text = document.text
  for (const change of params.contentChanges) {
    text = change.range ? text.slice(0, offset(text, change.range.start)) + change.text + text.slice(offset(text, change.range.end)) : change.text
  }
  return { ...document, text, version: params.textDocument.version }
}

function rememberDocument(documents, method, params) {
  const uri = params.textDocument?.uri
  if (method === 'textDocument/didOpen') documents.set(uri, { ...params.textDocument })
  if (method === 'textDocument/didClose') documents.delete(uri)
  const document = documents.get(uri)
  if (!document) return
  if (method === 'textDocument/didChange') documents.set(uri, changeDocument(document, params))
  if (method === 'textDocument/didSave' && typeof params.text === 'string') documents.set(uri, { ...document, text: params.text })
}

export function rememberTsState(state, message) {
  const { method, params = {} } = message
  if (method?.startsWith('textDocument/did')) rememberDocument(state.documents, method, params)
  if (method === 'workspace/didChangeConfiguration') state.configuration = message
  if (method === 'workspace/didChangeWorkspaceFolders') {
    const folders = new Map((state.initialize.params.workspaceFolders ?? []).map(folder => [folder.uri, folder]))
    for (const folder of params.event.removed) folders.delete(folder.uri)
    for (const folder of params.event.added) folders.set(folder.uri, folder)
    state.initialize = { ...state.initialize, params: { ...state.initialize.params, workspaceFolders: [...folders.values()] } }
  }
}

export function tsReplayState(state) {
  const frames = [{ jsonrpc: '2.0', method: 'initialized', params: {} }]
  if (state.configuration) frames.push(state.configuration)
  for (const document of state.documents.values()) frames.push({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: document } })
  return frames
}
