function fenceMarker(line) {
  return /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line)?.[1] ?? null
}

function closesFence(line, fence) {
  const marker = fenceMarker(line)
  return marker?.[0] === fence[0] && marker.length >= fence.length && /^[ \t]*$/.test(line.slice(line.indexOf(marker) + marker.length))
}

export function cardDefinitionOfDone(content, { raw = false } = {}) {
  const lines = (typeof content === 'string' ? content : '').split(/\n/)
  let fence = null
  let sectionStart = -1
  let legacySectionStart = -1
  for (let index = 0; index < lines.length; index += 1) {
    const marker = fenceMarker(lines[index])
    if (!fence && marker) { fence = marker; continue }
    if (fence) {
      if (closesFence(lines[index], fence)) fence = null
      continue
    }
    if (/^##[ \t]+(?:Definition of done|DoD)[ \t]*$/i.test(lines[index])) { sectionStart = index + 1; break }
    // Existing persisted cards used a bare empty label above a numbered list; keep that concrete
    // card shape on the same parser while new inline labels require their criterion on the line.
    if (/^[ \t]*(?:Definition of done|DoD)[ \t]*:[ \t]*$/i.test(lines[index])) legacySectionStart = index + 1
  }
  if (sectionStart < 0) sectionStart = legacySectionStart

  if (sectionStart >= 0) {
    const criteria = []
    let criterion = null
    fence = null
    const finish = () => {
      if (criterion) {
        if (raw) while (criterion.at(-1) === '') criterion.pop()
        criteria.push(raw ? criterion.join('\n') : criterion.filter((line) => line.trim() && !fenceMarker(line)).map((line) => line.trim()).join(' '))
      }
      criterion = null
    }
    for (let index = sectionStart; index < lines.length; index += 1) {
      const line = lines[index]
      const marker = fenceMarker(line)
      if (fence) {
        if (raw && criterion) criterion.push(line)
        if (closesFence(line, fence)) fence = null
        continue
      }
      if (marker) {
        fence = marker
        if (raw && criterion) criterion.push(line)
        continue
      }
      if (/^[ \t]{0,3}#{1,6}(?:[ \t]+|$)/.test(line)) break
      const item = /^(?:[-*][ \t]+|\d+\.[ \t]+)(\S.*)$/.exec(line)
      if (item) { finish(); criterion = [item[1]]; continue }
      if (criterion && (line.trim() || raw)) criterion.push(line)
    }
    finish()
    return criteria
  }

  fence = null
  for (const line of lines) {
    const marker = fenceMarker(line)
    if (!fence && marker) { fence = marker; continue }
    if (fence) {
      if (closesFence(line, fence)) fence = null
      continue
    }
    const inline = /^[ \t]*(?:-[ \t]+)?(?:Definition of done|DoD)[ \t]*:[ \t]*(\S.*)$/i.exec(line)
    if (inline) return [raw ? inline[1] : inline[1].trimEnd()]
  }
  return []
}
