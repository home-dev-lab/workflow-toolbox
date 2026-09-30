// The platform this process runs on, read once at the host boundary so callers can default to it without
// reaching `process.platform` themselves.
export const hostPlatform = process.platform
