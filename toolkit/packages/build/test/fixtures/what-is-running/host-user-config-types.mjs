// The plugin `userConfig` types Claude Code's manifest validator accepts. One list, read by two checks:
// - hooks.selftest.mjs asserts every type plugin.json declares is in it (runs everywhere, CI included, with no
//   `claude` binary): a type outside it makes the host refuse the WHOLE plugin, and /wir then reads unknown;
// - plugin-host-validate.test.ts pins this list against the INSTALLED host, where one is available: every
//   candidate type (this list plus plausible types outside it) is validated by `claude plugin validate --strict`,
//   and the accepted set must equal this list exactly. A host that starts accepting a type, or stops, turns that
//   test red rather than leaving this list stale.
//
// Documented set (plugins-reference, "User configuration"): "One of `string`, `number`, `boolean`, `directory`,
// or `file`". Measured 2026-09-25 on Claude Code 2.1.282: those five pass; `array`, `object`, `integer` and
// `path` fail with "userConfig.<key>.type: Invalid input".
export const HOST_USER_CONFIG_TYPES = Object.freeze(['boolean', 'directory', 'file', 'number', 'string']);

