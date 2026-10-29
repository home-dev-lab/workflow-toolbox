import { readFileSync } from 'node:fs'
import { absoluteSnapshotSpelling, createAdmissionSnapshot } from './admission-snapshot.mjs'
import { renderSecondOpinionRequest } from '../second-opinion-prompt.mjs'

export async function withSecondOpinionSnapshot(options, run) {
  // Read the caller's request once, before copying or admitting anything.
  const bytes = readFileSync(options.request)
  const snapshot = createAdmissionSnapshot(options.repo, [absoluteSnapshotSpelling(options.repoSpelling)])
  try {
    const requestText = renderSecondOpinionRequest(snapshot.repo, snapshot.rewrite(bytes.toString('utf8')), options.route)
    const request = snapshot.writeRequest(requestText)
    snapshot.freeze()
    return await run({ ...options, snapshot, originalRepo: snapshot.originalRepo, repo: snapshot.repo, request, requestText, requestRendered: true })
  } finally {
    snapshot.dispose()
  }
}
