function linesOf(text) {
  const lines = []
  let start = 0, index = 0
  while (index < text.length) {
    if (text[index] !== '\n' && text[index] !== '\r') { index++; continue }
    const next = text[index] === '\r' && text[index + 1] === '\n' ? index + 2 : index + 1
    lines.push(makeLine(text, start, index, next))
    start = next; index = next
  }
  lines.push(makeLine(text, start, text.length, text.length))
  return lines
}

function makeLine(text, start, end, next) {
  return { pieces: [{ text, start, end }], ending: text.slice(end, next), length: end - start }
}

function pieceRange(pieces, start, end) {
  const result = []
  let offset = 0
  for (const piece of pieces) {
    const length = piece.end - piece.start
    const from = Math.max(start - offset, 0), to = Math.min(end - offset, length)
    if (to > from) result.push({ text: piece.text, start: piece.start + from, end: piece.start + to })
    offset += length
    if (offset >= end) break
  }
  return result
}

function renderLines(lines) {
  return lines.map(line => line.pieces.map(piece => piece.text.slice(piece.start, piece.end)).join('') + line.ending).join('')
}

function positionIn(lines, position) {
  const line = Math.max(0, Math.min(position.line, lines.length - 1))
  const { length } = lines[line]
  return { line, character: position.line >= lines.length ? length : Math.max(0, Math.min(position.character, length)) }
}

function applyChange(lines, change) {
  if (!change.range) return linesOf(change.text)
  const start = positionIn(lines, change.range.start), end = positionIn(lines, change.range.end)
  const replacement = linesOf(change.text)
  const first = replacement[0], last = replacement.at(-1)
  first.pieces = pieceRange(lines[start.line].pieces, 0, start.character).concat(first.pieces)
  first.length += start.character
  last.pieces = last.pieces.concat(pieceRange(lines[end.line].pieces, end.character, lines[end.line].length))
  last.length += lines[end.line].length - end.character
  last.ending = lines[end.line].ending
  // Avoid spreading arbitrarily many lines into a call's argument stack.
  return lines.slice(0, start.line).concat(replacement, lines.slice(end.line + 1))
}

function changeDocument(document, params) {
  let lines = document.lines
  for (const change of params.contentChanges) {
    lines = applyChange(lines, change)
  }
  return { ...document, lines, version: params.textDocument.version }
}

function rememberDocument(documents, method, params) {
  const uri = params.textDocument?.uri
  if (method === 'textDocument/didOpen') documents.set(uri, { ...params.textDocument, text: undefined, lines: linesOf(params.textDocument.text) })
  if (method === 'textDocument/didClose') documents.delete(uri)
  const document = documents.get(uri)
  if (!document) return
  if (method === 'textDocument/didChange') documents.set(uri, changeDocument(document, params))
  if (method === 'textDocument/didSave' && typeof params.text === 'string') documents.set(uri, { ...document, lines: linesOf(params.text) })
}

function updateWorkspaceFolders(state, params) {
  const root = state.initialize.params.rootUri
  const fallback = root ? [{ uri: root, name: root.split('/').at(-1) || root }] : []
  const folders = new Map((state.initialize.params.workspaceFolders ?? fallback).map(folder => [folder.uri, folder]))
  for (const folder of params.event.removed) folders.delete(folder.uri)
  for (const folder of params.event.added) folders.set(folder.uri, folder)
  state.initialize = { ...state.initialize, params: { ...state.initialize.params, workspaceFolders: [...folders.values()] } }
}

export function rememberTsState(state, message) {
  const { method, params = {} } = message
  if (method?.startsWith('textDocument/did')) rememberDocument(state.documents, method, params)
  if (method === 'workspace/didChangeConfiguration') state.configuration = message
  if (method === 'workspace/didChangeWorkspaceFolders') updateWorkspaceFolders(state, params)
}

export function tsReplayState(state) {
  const frames = [{ jsonrpc: '2.0', method: 'initialized', params: {} }]
  if (state.configuration) frames.push(state.configuration)
  for (const { lines, ...document } of state.documents.values()) frames.push({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { ...document, text: renderLines(lines) } } })
  return frames
}
