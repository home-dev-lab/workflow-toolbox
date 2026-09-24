// Single source of truth: normalize untrusted options once behind a scoped test seam.
const defaults = Object.freeze({
  opAccount: '',
  opBinary: 'op',
  maskEmails: false,
  maskIpAddresses: false,
  secretFileReadWarnings: true,
});

let configured = defaults;

export function configure(options = {}) {
  configured = Object.freeze({
    opAccount: typeof options.opAccount === 'string' ? options.opAccount.trim() : '',
    opBinary: typeof options.opBinary === 'string' && options.opBinary.trim() ? options.opBinary.trim() : 'op',
    maskEmails: options.maskEmails === true || options.maskEmails === 'true',
    maskIpAddresses: options.maskIpAddresses === true || options.maskIpAddresses === 'true',
    secretFileReadWarnings: options.secretFileReadWarnings !== false && options.secretFileReadWarnings !== 'false',
  });
  return configured;
}

export function config() { return configured; }
