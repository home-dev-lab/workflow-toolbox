// Functional core: recursively mask values without performing host I/O.
import { detections, entropyCandidates, optionalDetections } from './detector.js';
import { config } from './config.js';
import { knownTokens, tokenize } from './token-vault.js';

function replaceKnown(text, command, includeOptional) {
  let scrubbed = text;
  const options = config();
  for (const [token, entry] of knownTokens()) {
    const optionalEnabled = includeOptional && ((entry.kind === 'email' && options.maskEmails) || (entry.kind === 'ip-address' && options.maskIpAddresses));
    const contextSensitive = entry.kind === 'credential-uuid';
    if (!contextSensitive && ((entry.kind !== 'email' && entry.kind !== 'ip-address') || optionalEnabled)) scrubbed = scrubbed.split(entry.value).join(token);
  }
  const found = [
    ...detections(scrubbed, command),
    ...(includeOptional ? optionalDetections(scrubbed, { emails: options.maskEmails, ipAddresses: options.maskIpAddresses }) : []),
  ];
  for (const { kind, value, secret = value } of found) scrubbed = scrubbed.split(value).join(tokenize(kind, secret));
  return { value: scrubbed, changed: scrubbed !== text, entropy: entropyCandidates(scrubbed) };
}

export function scrub(value, command, includeOptional = true) {
  if (typeof value === 'string') return replaceKnown(value, command, includeOptional);
  if (Array.isArray(value)) {
    let changed = false; let entropy = 0;
    const result = value.map((item) => { const next = scrub(item, command, includeOptional); changed ||= next.changed; entropy += next.entropy; return next.value; });
    return { value: result, changed, entropy };
  }
  if (value && typeof value === 'object') {
    let changed = false; let entropy = 0;
    const result = {};
    for (const [key, item] of Object.entries(value)) { const next = scrub(item, command, includeOptional); result[key] = next.value; changed ||= next.changed; entropy += next.entropy; }
    return { value: result, changed, entropy };
  }
  return { value, changed: false, entropy: 0 };
}
