const patterns = [
  ['github-classic', /\bghp_[A-Za-z0-9]{36}\b/g],
  ['github-fine-grained', /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g],
  ['aws-access-key', /\bAKIA[A-Z0-9]{16}\b/g],
  ['openai-api-key', /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ['slack-token', /\bxox[abp]-[A-Za-z0-9-]{10,}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['assignment', /\b(?:password|token|secret)\s*=\s*(?:"[^"]+"|'[^']+'|[^\s;]+)/gi],
  ['op-output', /^\s*(?:password|token|secret|credential)\s*:\s*\S.+$/gim],
  ['environment-dump', /^\s*[A-Z][A-Z0-9_]*(?:_TOKEN|_KEY|_SECRET)\s*=\s*\S.+$/gm],
];

const sha = /\b[a-f0-9]{40}\b/gi;
const uuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const secretToken = /\bsecret:[a-z-]+#[a-f0-9]{6}\b/gi;
const email = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}\b/g;
const ipv4 = /(?<![0-9.])(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(?:\.(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}(?![0-9.])/g;
const ipv6Candidate = /(?<![0-9A-Fa-f:])[0-9A-Fa-f]*:[0-9A-Fa-f:]+(?![0-9A-Fa-f:])/g;

export function allowedRanges(text, command = '') {
  const ranges = [];
  for (const expression of [sha, uuid, secretToken]) {
    expression.lastIndex = 0;
    for (let match; (match = expression.exec(text));) ranges.push([match.index, match.index + match[0].length]);
  }
  // Base64 is only allow-listed when the command names a file, never as a blanket exemption.
  if (/\b(?:cat|base64|openssl)\s+[^\s]+/.test(command)) {
    const base64 = /\b[A-Za-z0-9+/]{32,}={0,2}\b/g;
    for (let match; (match = base64.exec(text));) ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

function overlaps(start, end, ranges) {
  return ranges.some(([from, to]) => start < to && end > from);
}

export function detections(text, command = '') {
  if (typeof text !== 'string') return [];
  const allowed = allowedRanges(text, command);
  const found = [];
  for (const [kind, expression] of patterns) {
    expression.lastIndex = 0;
    for (let match; (match = expression.exec(text));) {
      if (!overlaps(match.index, match.index + match[0].length, allowed)) found.push({ kind, value: match[0] });
    }
  }
  return found;
}

function isIpv6(value) {
  if ((value.match(/::/g) ?? []).length > 1) return false;
  const compressed = value.includes('::');
  const parts = value.split(':').filter(Boolean);
  if (!parts.every((part) => /^[0-9A-Fa-f]{1,4}$/.test(part))) return false;
  return compressed ? parts.length < 8 : parts.length === 8;
}

export function optionalDetections(text, options = {}) {
  if (typeof text !== 'string') return [];
  const found = [];
  if (options.emails) {
    email.lastIndex = 0;
    for (let match; (match = email.exec(text));) found.push({ kind: 'email', value: match[0] });
  }
  if (options.ipAddresses) {
    ipv4.lastIndex = 0;
    for (let match; (match = ipv4.exec(text));) found.push({ kind: 'ip-address', value: match[0] });
    ipv6Candidate.lastIndex = 0;
    for (let match; (match = ipv6Candidate.exec(text));) {
      if (isIpv6(match[0])) found.push({ kind: 'ip-address', value: match[0] });
    }
  }
  return found;
}

export function entropyCandidates(text) {
  if (typeof text !== 'string') return 0;
  const candidates = text.match(/\b[A-Za-z0-9+/_-]{32,}\b/g) ?? [];
  return candidates.filter((value) => entropy(value) >= 4.2).length;
}

function entropy(value) {
  const counts = new Map();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  return [...counts.values()].reduce((sum, count) => {
    const p = count / value.length;
    return sum - p * Math.log2(p);
  }, 0);
}
