// Decimal text arithmetic: no IEEE rounding, exponent expansion, or huge integer conversions.
export const decimalWork = { steps: 0, reset() { this.steps = 0; } };
const DECIMAL = /^(-?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?)(\d+))?$/;

function magnitude(value) {
  let start = 0;
  while (value[start] === '0') { start += 1; decimalWork.steps += 1; }
  return value.slice(start) || '0';
}

function unsignedAdd(left, right) {
  const digits = [];
  let carry = 0;
  for (let a = left.length - 1, b = right.length - 1; a >= 0 || b >= 0 || carry; a -= 1, b -= 1) {
    const sum = (left.charCodeAt(a) - 48 || 0) + (right.charCodeAt(b) - 48 || 0) + carry;
    digits.push(String(sum % 10)); carry = Math.floor(sum / 10); decimalWork.steps += 1;
  }
  return digits.reverse().join('');
}

function unsignedSubtract(left, right) {
  const digits = [];
  let borrow = 0;
  for (let a = left.length - 1, b = right.length - 1; a >= 0; a -= 1, b -= 1) {
    let digit = left.charCodeAt(a) - 48 - (right.charCodeAt(b) - 48 || 0) - borrow;
    borrow = digit < 0 ? 1 : 0;
    if (borrow) digit += 10;
    digits.push(String(digit)); decimalWork.steps += 1;
  }
  return magnitude(digits.reverse().join(''));
}

function subtractMagnitudes(left, right, leftLarger) {
  const larger = leftLarger ? left : right;
  const smaller = leftLarger ? right : left;
  return unsignedSubtract(larger, smaller);
}

function signedAdd(sign, digits, adjustment) {
  const left = magnitude(digits);
  const right = String(Math.abs(adjustment));
  const negative = sign === '-' && left !== '0';
  if (negative === (adjustment < 0)) return `${negative ? '-' : ''}${unsignedAdd(left, right)}`;
  const leftLarger = left.length > right.length || (left.length === right.length && left >= right);
  const result = subtractMagnitudes(left, right, leftLarger);
  if (result === '0') return '0';
  const resultNegative = leftLarger ? negative : adjustment < 0;
  return `${resultNegative ? '-' : ''}${result}`;
}

function decimalFraction(match) { return match[3] ?? match[4] ?? ''; }

function canonicalDecimal(text) {
  decimalWork.steps += text.length;
  const match = DECIMAL.exec(text);
  if (!match) return null;
  const fraction = decimalFraction(match);
  const digits = (match[2] ?? '') + fraction;
  let first = 0;
  let last = digits.length;
  while (first < last && digits[first] === '0') { first += 1; decimalWork.steps += 1; }
  if (first === last) return { coefficient: '0', exponent: '0' };
  while (digits[last - 1] === '0') { last -= 1; decimalWork.steps += 1; }
  const coefficient = match[1] + digits.slice(first, last);
  const exponent = signedAdd(match[5] ?? '', match[6] ?? '0', digits.length - last - fraction.length);
  return { coefficient, exponent };
}

export function numericEquals(held, number) {
  const left = canonicalDecimal(held);
  const right = canonicalDecimal(String(number));
  return left !== null && right !== null && left.coefficient === right.coefficient && left.exponent === right.exponent;
}
