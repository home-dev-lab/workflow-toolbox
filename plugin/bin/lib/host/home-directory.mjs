import { homedir } from 'node:os'

// The account's home directory as the operating system reports it. Kept behind the host adapter
// so callers that only need the path stay free of raw OS access.
export function homeDirectory() {
  return homedir()
}
