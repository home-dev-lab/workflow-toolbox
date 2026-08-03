// commit-signature-core.mjs — pure parsing/classification logic behind
// wt-check-commit-signatures.mjs. Kept separate so tests can drive the
// decision logic without spawning git.

const ACCEPTABLE_STATUSES = new Set(['G', 'U']);

const STATUS_MEANINGS = {
  G: 'good signature',
  U: 'good signature, untrusted key',
  N: 'no signature',
  B: 'bad signature',
  E: 'signature check error',
  X: 'expired signature',
  Y: 'expired signing key',
  R: 'revoked signing key',
};

function isTruthyGitBoolean(value) {
  return /^(true|yes|on|1)$/i.test(String(value || '').trim());
}

function parseConfigLines(configLines) {
  let commitGpgsign = null;
  let signingKey = null;

  for (const rawLine of configLines || []) {
    const line = String(rawLine || '').trim();
    if (!line) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === 'commit.gpgsign') commitGpgsign = value;
    if (key === 'user.signingkey') signingKey = value;
  }

  return {
    signingExpected: isTruthyGitBoolean(commitGpgsign) || Boolean(signingKey),
  };
}

export function statusMeaning(status) {
  return STATUS_MEANINGS[status] || 'unknown signature status';
}

export function checkSignatures({ configLines = [], logLines = [] } = {}) {
  const { signingExpected } = parseConfigLines(configLines);
  if (!signingExpected) {
    return {
      signingExpected: false,
      offenders: [],
      flagged: false,
      reasons: [],
    };
  }

  const offenders = [];
  const reasons = [];

  for (const rawLine of logLines || []) {
    const line = String(rawLine || '');
    if (!line.trim()) continue;
    const [sha = '', status = '', subject = ''] = line.split('\t');
    if (!sha || status.length !== 1) {
      reasons.push(`malformed git log line: ${line}`);
      continue;
    }
    if (ACCEPTABLE_STATUSES.has(status)) continue;
    offenders.push({ sha, status, subject, meaning: statusMeaning(status) });
  }

  return {
    signingExpected,
    offenders,
    flagged: offenders.length > 0,
    reasons,
  };
}
