// Failure-only console boundary: variable text never defines a notice's identity.
const noticed = new Map();

export async function consoleNotice(host, noticeId, text) {
  const sessionId = await host.sessionId();
  let session = noticed.get(sessionId);
  if (!session) { session = new Set(); noticed.set(sessionId, session); }
  if (session.has(noticeId)) return false;
  // Reserve before awaiting the host so concurrent failures cannot duplicate a line.
  session.add(noticeId);
  await host.uiLog(text);
  return true;
}
