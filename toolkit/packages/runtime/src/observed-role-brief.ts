// observed-role-brief.ts — auto-injected wt-comm observer-consumer pointer for
// observed roles.
//
// SANDBOX-PURE: no Node APIs, no non-determinism, no imports except local
// sandbox-pure types. This file is bundled into workflow artifacts.

import type { PromptTagFields } from './prompt-tag.js'

export interface ObservedSelector {
  roles?: string[]
  phases?: string[]
}

const SALT_SUFFIX_RE = / #(\d+|[A-Za-z0-9_.-]{1,32})$/
const NUMERIC_SEGMENT_RE = /^\d+$/

// Twin of workflow-observatory apps/observe-ui/server/observer-match.ts:131-172.
// The observe server and this runtime-side prompt injector must not drift.
export function labelRole(label: string): string[] {
  const stripped = label.replace(SALT_SUFFIX_RE, '')
  return stripped.split(':').filter((seg) => seg.length > 0 && !NUMERIC_SEGMENT_RE.test(seg))
}

function selectorRoles(selector: ObservedSelector): string[] {
  return selector.roles ?? []
}

function selectorPhases(selector: ObservedSelector): string[] {
  return selector.phases ?? []
}

export function matchesSelector(tag: PromptTagFields, selector: ObservedSelector): boolean {
  const roles = selectorRoles(selector)
  const phases = selectorPhases(selector)
  const roleMatch = roles.length === 0
    || (tag.label !== undefined && roles.some((role) => labelRole(tag.label!).includes(role)))
  const phaseMatch = phases.length === 0
    || (tag.phase !== undefined && phases.includes(tag.phase))
  return roleMatch && phaseMatch
}

export function matchedRoleId(tag: { label?: string | undefined }, selector: ObservedSelector): string | undefined {
  if (tag.label === undefined) return undefined
  const candidates = labelRole(tag.label)
  if (candidates.length === 0) return undefined

  const roles = selectorRoles(selector)
  if (roles.length > 0) {
    return roles.find((role) => candidates.includes(role))
  }

  const phases = selectorPhases(selector)
  return phases.length > 0 ? candidates[0] : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringEntries(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string')
}

function extractSelector(watch: Record<string, unknown>): ObservedSelector {
  const selector: ObservedSelector = {}
  if (Object.hasOwn(watch, 'roles')) {
    const roles = stringEntries(watch['roles'])
    if (roles !== undefined) selector.roles = roles
  }
  if (Object.hasOwn(watch, 'phases')) {
    const phases = stringEntries(watch['phases'])
    if (phases !== undefined) selector.phases = phases
  }
  return selector
}

export function extractObservedSelectors(args: unknown): ObservedSelector[] {
  if (!isRecord(args) || !Object.hasOwn(args, 'observers') || !Array.isArray(args['observers'])) {
    return []
  }

  const selectors: ObservedSelector[] = []
  for (const entry of args['observers']) {
    if (!isRecord(entry) || !Object.hasOwn(entry, 'definition')) continue
    const definition = entry['definition']
    if (!isRecord(definition)) continue
    if (!Object.hasOwn(definition, 'actions') || !Array.isArray(definition['actions']) || !definition['actions'].includes('wt-comm')) {
      continue
    }
    if (!Object.hasOwn(definition, 'emits') || !Array.isArray(definition['emits']) || definition['emits'].length === 0) {
      continue
    }
    if (!Object.hasOwn(definition, 'watch') || !isRecord(definition['watch'])) {
      continue
    }
    const selector = extractSelector(definition['watch'])
    // A6 twin (observer-def.ts "watch needs at least one selector", enforced launch-side):
    // a degenerate selector would be match-all here yet resolve no role id — drop it so it
    // can never shadow a later well-formed one.
    if ((selector.roles?.length ?? 0) === 0 && (selector.phases?.length ?? 0) === 0) continue
    selectors.push(selector)
  }
  return selectors
}

export function buildObservedRoleSection(roleId: string): string {
  return `---
OBSERVED ROLE BRIEF (auto-injected: an observer watches this run)
An attached observer may leave you typed \`observer.hint\` messages. Follow the
observed-role consumer brief of the wt-comm teaching pack: the file
\`teaching/wt-comm-observer-consumer.md\` inside the installed
\`@workflow-toolbox/comm\` package (read that file — it defines the conduct
rules, how to list unread hints, and the read-settlement marker; reference it,
never copy it). Your parameters:
- ROLE_ID: "${roleId}" (hints are addressed to this role name)
- WT_COMM_DIR and RUN_ID: read the JSON file named by the environment variable
  WT_COMM_PARAMS. One-liner:
  export WT_COMM_DIR=$(sed -n 's/.*"commDir" *: *"\\([^"]*\\)".*/\\1/p' "$WT_COMM_PARAMS") ROLE_ID="${roleId}"
  (the \`runId\` key in the same file is your RUN_ID.)
If WT_COMM_PARAMS is unset or the params file does not exist yet, the delivery
channel is inactive at this boundary: proceed unobserved and re-check at a
later natural boundary. Consult hints at NATURAL BOUNDARIES only; a missing or
unreadable channel never fails your task.`
}

export function observedBriefFor(selectors: readonly ObservedSelector[]): (fields: PromptTagFields) => string | null {
  if (selectors.length === 0) return () => null
  return (fields) => {
    // First selector that matches AND resolves a role id wins — a matching but role-less
    // selector (possible when callers pass hand-built selectors) must not starve later ones.
    for (const selector of selectors) {
      if (!matchesSelector(fields, selector)) continue
      const roleId = matchedRoleId(fields, selector)
      if (roleId !== undefined) return buildObservedRoleSection(roleId)
    }
    return null
  }
}
