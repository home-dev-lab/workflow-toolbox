// Host access for a launched process's captured stdout and stderr: two exclusive files opened
// read-write, handed to the child as descriptors, and read back through those same descriptors.
// Never by path: a lane's worker removes its --brief-cleanup-dir (where the SDK pilot lifecycle keeps
// these files) when the lane ends, and wt-lane.mjs keeps its launcher alive until the new lane is
// counted, which can be after that end. An unlinked file stays readable through an open descriptor.
import fs from 'node:fs'

export function openLaunchOutputs(stdoutPath, stderrPath) {
  const stdoutFd = fs.openSync(stdoutPath, 'wx+', 0o600)
  try {
    return [stdoutFd, fs.openSync(stderrPath, 'wx+', 0o600)]
  } catch (error) {
    fs.closeSync(stdoutFd)
    throw error
  }
}

// Positioned reads from offset 0: the child advanced the shared file offset to the end.
export function readLaunchOutput(fd) {
  const size = fs.fstatSync(fd).size
  const buffer = Buffer.alloc(size)
  let offset = 0
  while (offset < size) {
    const count = fs.readSync(fd, buffer, offset, size - offset, offset)
    if (count === 0) break
    offset += count
  }
  return buffer.toString('utf8', 0, offset)
}

export function closeLaunchOutputs(fds) {
  for (const fd of fds) fs.closeSync(fd)
}
