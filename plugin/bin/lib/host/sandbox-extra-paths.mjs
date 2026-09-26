// The sandbox builds POSIX paths even when its caller runs on another platform.
export const sandboxExtraPaths = (value) => String(value ?? '').split(':').map((item) => item.trim()).filter(Boolean)
