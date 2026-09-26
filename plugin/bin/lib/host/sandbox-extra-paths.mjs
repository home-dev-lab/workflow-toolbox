// The sandbox builds POSIX paths even when its caller runs on another platform.
export const sandboxExtraPaths = (value) => String(value ?? '').split(':').map((item) => item.trim()).filter(Boolean)

// bwrap is Linux-only. Null disables the entire decision-state preflight on Windows,
// where splitting C:\\ paths on ':' would manufacture bogus writable paths.
export const sandboxWritablePaths = (value, platform = process.platform) => platform === 'win32' ? null : sandboxExtraPaths(value)
