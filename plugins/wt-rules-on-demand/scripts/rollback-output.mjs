// Shared text channel for applying timer runs and the next SessionStart.
export function rollbackOutcomeLines(result) {
  const rows = [
    ...(result.reverted ?? []).map((row) => ({ ...row, action: 'reverted' })),
    ...(result.wouldRevert ?? []).map((row) => ({ ...row, action: 'would revert' })),
    ...(result.attention ?? []).map((row) => ({ ...row, action: 'attention' })),
    ...(result.failed ?? []).map((row) => ({ ...row, action: 'failed' })),
    ...(result.refused ?? []).map((row) => ({ ...row, action: 'refused' })),
  ];
  return [...new Set(rows.map((row) => `rules-on-demand rollback: ${row.scope ?? 'scope'} ${row.rule ?? row.root ?? row.rulesDir ?? 'unknown'}: ${row.action}: ${row.reason || row.error || row.stderr || 'unknown failure'}`))];
}
