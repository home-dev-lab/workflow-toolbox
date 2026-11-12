export const HELD_VALUE_FLOOR = 6;
const ALNUM = /[A-Za-z0-9]/;
export const standsAlone = (text, at, length) => !ALNUM.test(text[at - 1] ?? '') && !ALNUM.test(text[at + length] ?? '');
export function base64Utf8(value) {
  let binary = '';
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
