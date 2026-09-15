import wordlistText from '../assets/passman-wordlist-v1.txt';

const words = wordlistText.trim().split(/\r?\n/);
const uppercaseLetters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const digits = '0123456789';

function secureRandomIndex(max) {
  if (!Number.isSafeInteger(max) || max < 1 || max > 0x100000000) throw new RangeError('Invalid random range.');
  const values = new Uint32Array(1);
  const range = 0x100000000;
  const limit = range - (range % max);
  do globalThis.crypto.getRandomValues(values); while (values[0] >= limit);
  return values[0] % max;
}

function generatePassword() {
  // Three distinct words plus the uppercase-and-two-digit suffix provide
  // about 53 bits of entropy. Rejection sampling keeps every choice unbiased.
  const chosen = [];
  while (chosen.length < 3) {
    const word = words[secureRandomIndex(words.length)];
    if (!chosen.includes(word)) chosen.push(word);
  }
  const uppercase = uppercaseLetters[secureRandomIndex(uppercaseLetters.length)];
  const firstDigit = digits[secureRandomIndex(digits.length)];
  const secondDigit = digits[secureRandomIndex(digits.length)];
  return `${chosen.join('-')}-${uppercase}${firstDigit}${secondDigit}`;
}

export { generatePassword };
