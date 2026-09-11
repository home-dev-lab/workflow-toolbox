// Accepted card grammar: `Route: LITE|FULL` may be a plain or Markdown bullet line;
// Effort, Type, Files/Impact and DoD are single-line fields. The runner owns this before query().
const RISK = /\b(risk|guard|security|public surface|migration|destructive|unsafe)\b/i

export function deriveRoute(card) {
  const text = typeof card === 'string' ? card : ''
  const override = /^\s*(?:-\s+)?Route:\s*(LITE|FULL)\s*$/im.exec(text)?.[1]?.toUpperCase()
  if (override) return { route: override, reasons: [`human Route: ${override}`] }
  const reasons = []
  if (/\bEffort\s*:\s*(?:M|L|XL)\b/i.test(text)) reasons.push('effort >= M')
  if (/\bType\s*:\s*feature\b/i.test(text)) reasons.push('type feature')
  if (RISK.test(text)) reasons.push('risk word')
  const files = /(?:^|\n)\s*(?:Files?|Impact)\s*:\s*([^\n]+)/i.exec(text)?.[1] ?? ''
  const named = files.match(/[\w./-]+\.(?:[a-z]{1,8})\b/gi) ?? []
  if (new Set(named.map((name) => name.toLowerCase())).size > 3) reasons.push('more than 3 named files')
  if (!/^\s*(?:-\s+)?(?:Definition of done|DoD\s*:)\s*\S+/im.test(text)) reasons.push('no DoD')
  return { route: reasons.length ? 'FULL' : 'LITE', reasons: reasons.length ? reasons : ['all LITE signals clear'] }
}
