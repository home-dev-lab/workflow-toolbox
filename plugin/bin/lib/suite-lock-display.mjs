const DISPLAY_UNSAFE_RANGES = [[0x00, 0x1f], [0x7f, 0x9f], [0x200e, 0x200f], [0x2028, 0x2029], [0x202a, 0x202e], [0x2066, 0x2069]]
const displaySafe = (character) => {
  const code = character.codePointAt(0)
  return DISPLAY_UNSAFE_RANGES.some(([low, high]) => code >= low && code <= high) ? '?' : character
}
export const displayText = (value) => Array.from(String(value), displaySafe).join('')
export function displayArgv(argv) {
  if (!Array.isArray(argv)) return 'unknown command'
  const text = argv.map(displayText).join(' ')
  return text.length > 80 ? `${text.slice(0, 77)}...` : text
}
