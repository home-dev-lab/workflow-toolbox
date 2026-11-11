import { redactConfirmationCodes } from './owner-release.js';
import { redactDiagnostic } from './diagnostic-redaction.js';

// The complete denial crosses this boundary last. Empty text still means denial to the host.
export function finalizeDenial(result, findings = []) {
  if (!result || result.deny === undefined) return result;
  return { deny: redactDiagnostic(redactConfirmationCodes(result.deny), findings) };
}
