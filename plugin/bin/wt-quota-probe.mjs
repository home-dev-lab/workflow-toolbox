#!/usr/bin/env node
// Quota probe — reads the subscription rate-limit windows the /usage screen shows,
// via the same OAuth endpoint the CLI uses. Read the quota BEFORE a large fan-out:
// a run that dies at the wall mid-arc costs more than the check.
//
// READS ONLY: this probe reads `<configDir>/.credentials.json` and NEVER writes it.
// TOKEN HYGIENE: the access token is used only as the `Authorization` header and
// is never printed or logged.
// ENDPOINT RISK: `https://api.anthropic.com/api/oauth/usage` is not publicly
// documented by Anthropic and may change or disappear without notice.
//
// Config-dir aware: reads credentials from the active `CLAUDE_CONFIG_DIR`
// (default ~/.claude), so it reports the ACTIVE account's quota. Output: one
// compact JSON line.
//
// Usage: node <plugin>/bin/wt-quota-probe.mjs
// Exit codes: 0 ok · 1 no/expired credentials · 2 endpoint/network error

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')

let oauth
try {
  oauth = JSON.parse(readFileSync(join(configDir, '.credentials.json'), 'utf8')).claudeAiOauth
  if (!oauth?.accessToken) throw new Error('no accessToken')
} catch (e) {
  console.error(JSON.stringify({ error: `no credentials in ${configDir}: ${e.message}` }))
  process.exit(1)
}
if (oauth.expiresAt && oauth.expiresAt < Date.now()) {
  // The CLI refreshes this file on use; a stale token here usually just means run any
  // claude command first. Report rather than attempt a refresh (never mutate the file).
  console.error(JSON.stringify({ error: 'accessToken expired — run any claude command to refresh, then retry' }))
  process.exit(1)
}

try {
  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      Authorization: `Bearer ${oauth.accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'Content-Type': 'application/json',
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const d = await res.json()
  // Compact projection: the two windows + any scoped weekly buckets + active severities.
  const scoped = (d.limits ?? [])
    .filter((l) => l.kind === 'weekly_scoped' && l.scope)
    .map((l) => ({ scope: l.scope?.model?.display_name ?? l.scope?.surface ?? 'unknown', percent: l.percent, severity: l.severity }))
  // LOCAL-time reset display (never UTC — the raw ISO stays in resets_at for machines):
  // reset_local = "12:30" same-day / "Fri 11/07 18:00" otherwise; reset_in = "1h22" / "6j5h".
  // The delta is the actual pressure signal (20% with 40min left ≠ 20% with 4h left).
  const fmtWindow = (w) => {
    const out = { pct: w?.utilization ?? null, resets_at: w?.resets_at ?? null }
    if (out.resets_at) {
      // Rounded to the nearest MINUTE before formatting: the endpoint emits …:59.8-style
      // timestamps, and plain truncation would display "17:59" for an 18:00 reset.
      const t = new Date(Math.round(new Date(out.resets_at).getTime() / 60000) * 60000)
      if (!Number.isNaN(t.getTime())) {
        const now = new Date()
        const sameDay = t.toDateString() === now.toDateString()
        const hm = t.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
        out.reset_local = sameDay ? hm : `${t.toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: '2-digit' })} ${hm}`
        const mins = Math.max(0, Math.round((t.getTime() - now.getTime()) / 60000))
        out.reset_in = mins < 60 ? `${mins}min` : mins < 1440 ? `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}` : `${Math.floor(mins / 1440)}j${Math.floor((mins % 1440) / 60)}h`
      }
    }
    return out
  }
  const sevenDay = fmtWindow(d.seven_day)
  sevenDay.severity = (d.limits ?? []).find((l) => l.kind === 'weekly_all')?.severity ?? null
  // ⚠ NOT every account HAS a subscription quota. Usage-billed (pay-per-token) accounts have
  // no five-hour or seven-day window at all, and the endpoint simply omits them. Left implicit,
  // `fmtWindow` then yields `{pct: null}` — and a consumer that renders or compares that null
  // shows a percentage for a limit which does not exist. A monitor reporting a reassuring
  // number on an account it cannot measure is worse than no monitor: the unmeasurable state
  // becomes indistinguishable from a healthy one.
  //
  // So the distinction is made EXPLICIT and named, rather than left to be inferred from nulls:
  //   'subscription' — at least one real window exists; percentages mean something
  //   'none'         — no window at all; this account is usage-billed. Consumers must stay
  //                    SILENT, not report 0% or null%.
  // Anything reading this file should branch on `quota_model`, never on the presence of a pct.
  const hasWindow = (w) => Number.isFinite(w?.utilization) || Boolean(w?.resets_at)
  const quotaModel = hasWindow(d.five_hour) || hasWindow(d.seven_day) ? 'subscription' : 'none'
  console.log(
    JSON.stringify({
      configDir,
      quota_model: quotaModel,
      five_hour: fmtWindow(d.five_hour),
      seven_day: sevenDay,
      weekly_scoped: scoped,
    }),
  )
} catch (e) {
  console.error(JSON.stringify({ error: `usage endpoint failed: ${e.message}` }))
  process.exit(2)
}
