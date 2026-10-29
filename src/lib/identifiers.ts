// Validators for the standard identifiers clearing houses, custodians and banks
// use. These only CHECK format and check digits. Identifiers are assigned by
// others (ISIN by a national numbering agency, SEDOL by the LSE, CUSIP by CUSIP
// Global Services, LEI by a GLEIF-accredited LOU); we never generate them.

const alnumValue = (c: string) => (/\d/.test(c) ? Number(c) : c.charCodeAt(0) - 55); // A=10 ... Z=35

// LEI, ISO 17442: 20 alphanumerics, ISO 7064 MOD 97-10 check (whole number mod 97 == 1).
export function validLei(s: string): boolean {
  if (!/^[A-Z0-9]{18}[0-9]{2}$/.test(s)) return false;
  let rem = 0;
  for (const c of s) for (const d of String(alnumValue(c))) rem = (rem * 10 + Number(d)) % 97;
  return rem === 1;
}

// ISIN, ISO 6166: 2-letter country, 9 alphanumerics, Luhn check digit.
export function validIsin(s: string): boolean {
  if (!/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(s)) return false;
  const digits = [...s].map((c) => String(alnumValue(c))).join('');
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let n = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

// SEDOL (London Stock Exchange): 6 alphanumerics with no vowels + check digit, weights 1,3,1,7,3,9,1.
export function validSedol(s: string): boolean {
  if (!/^[0-9BCDFGHJKLMNPQRSTVWXYZ]{6}[0-9]$/.test(s)) return false;
  const w = [1, 3, 1, 7, 3, 9, 1];
  return [...s].reduce((acc, c, i) => acc + alnumValue(c) * w[i], 0) % 10 === 0;
}

// CUSIP: 9 characters; every second value doubled, digits summed, check digit last.
export function validCusip(s: string): boolean {
  if (!/^[A-Z0-9*@#]{8}[0-9]$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    const c = s[i];
    let v = /\d/.test(c) ? Number(c) : /[A-Z]/.test(c) ? alnumValue(c) : { '*': 36, '@': 37, '#': 38 }[c]!;
    if (i % 2 === 1) v *= 2;
    sum += Math.floor(v / 10) + (v % 10);
  }
  return (10 - (sum % 10)) % 10 === Number(s[8]);
}

// CFI, ISO 10962: 6 letters; the first is the instrument category.
export const validCfi = (s: string) => /^[ECDRSOFHIJKLMT][A-Z]{5}$/.test(s);

// BIC / SWIFT code, ISO 9362: 8 or 11 characters.
export const validBic = (s: string) => /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(s);

export const identifierChecks = {
  isin: validIsin,
  sedol: validSedol,
  cusip: validCusip,
  cfi: validCfi,
} as const;
export type IdentifierKey = keyof typeof identifierChecks;
