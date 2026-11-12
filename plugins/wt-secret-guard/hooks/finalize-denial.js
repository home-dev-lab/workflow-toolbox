import { redactConfirmationCodes } from './owner-release.js';
import { redactDiagnostic } from './diagnostic-redaction.js';

// The complete denial crosses this boundary last. Empty text still means denial to the host.
export function finalizeDenial(result, findings = []) {
  if (!result || result.deny === undefined) return result;
  // An uninspected suffix can contain any proposed marker or fallback sentence.
  if (findings.some((item) => item.kind === 'inspection-budget')) return { deny: '' };
  return { deny: redactDiagnostic(redactConfirmationCodes(result.deny), findings) };
}
