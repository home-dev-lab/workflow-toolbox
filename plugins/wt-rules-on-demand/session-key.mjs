// FNV-1a/128 over UTF-16 bytes avoids sanitized-name aliases and bounds long ids.
export function sessionKey(sessionId) {
  let hash = 0x6c62272e07bb014262b821756295c58dn;
  const prime = 0x1000000000000000000013bn, mask = (1n << 128n) - 1n;
  for (let index = 0; index < sessionId.length; index++) {
    const code = sessionId.charCodeAt(index);
    hash = ((hash ^ BigInt(code & 255)) * prime) & mask;
    hash = ((hash ^ BigInt(code >>> 8)) * prime) & mask;
  }
  return `${sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 48)}-${hash.toString(16).padStart(32, '0')}`;
}
