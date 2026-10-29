// Amount in words, as written on a cheque: "Ten pounds only",
// "One thousand two hundred and fifty pounds and fifty pence only".
// British usage ("and" before the last two digits, hyphenated tens). Pure
// functions, shared by the server (sealed into the signed terms at issue) and
// the browser (live preview while typing).

const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES = ['', 'thousand', 'million', 'billion', 'trillion'];

interface Unit {
  major: [string, string]; // singular, plural
  minor?: [string, string];
}

const UNITS: Record<string, Unit> = {
  GBP: { major: ['pound', 'pounds'], minor: ['penny', 'pence'] },
  USD: { major: ['dollar', 'dollars'], minor: ['cent', 'cents'] },
  EUR: { major: ['euro', 'euros'], minor: ['cent', 'cents'] },
  AUD: { major: ['dollar', 'dollars'], minor: ['cent', 'cents'] },
  CAD: { major: ['dollar', 'dollars'], minor: ['cent', 'cents'] },
  NZD: { major: ['dollar', 'dollars'], minor: ['cent', 'cents'] },
  SGD: { major: ['dollar', 'dollars'], minor: ['cent', 'cents'] },
  HKD: { major: ['dollar', 'dollars'], minor: ['cent', 'cents'] },
  CHF: { major: ['franc', 'francs'], minor: ['centime', 'centimes'] },
  ZAR: { major: ['rand', 'rand'], minor: ['cent', 'cents'] },
  INR: { major: ['rupee', 'rupees'], minor: ['paisa', 'paise'] },
  AED: { major: ['dirham', 'dirhams'], minor: ['fils', 'fils'] },
  JPY: { major: ['yen', 'yen'] },
  BRL: { major: ['real', 'reais'], minor: ['centavo', 'centavos'] },
  CZK: { major: ['koruna', 'koruny'], minor: ['haler', 'haleru'] },
  DKK: { major: ['krone', 'kroner'], minor: ['ore', 'ore'] },
  NOK: { major: ['krone', 'kroner'], minor: ['ore', 'ore'] },
  SEK: { major: ['krona', 'kronor'], minor: ['ore', 'ore'] },
  HUF: { major: ['forint', 'forint'] },
  ILS: { major: ['shekel', 'shekels'], minor: ['agora', 'agorot'] },
  MYR: { major: ['ringgit', 'ringgit'], minor: ['sen', 'sen'] },
  MXN: { major: ['peso', 'pesos'], minor: ['centavo', 'centavos'] },
  PHP: { major: ['peso', 'pesos'], minor: ['centavo', 'centavos'] },
  PLN: { major: ['zloty', 'zlotys'], minor: ['grosz', 'groszy'] },
  RUB: { major: ['ruble', 'rubles'], minor: ['kopek', 'kopeks'] },
  THB: { major: ['baht', 'baht'], minor: ['satang', 'satang'] },
  TRY: { major: ['lira', 'lira'], minor: ['kurus', 'kurus'] },
};

function underThousand(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const parts: string[] = [];
  if (h) parts.push(`${ONES[h]} hundred`);
  if (r) {
    if (h) parts.push('and');
    parts.push(r < 20 ? ONES[r] : TENS[Math.floor(r / 10)] + (r % 10 ? `-${ONES[r % 10]}` : ''));
  }
  return parts.join(' ');
}

// Whole number as words. `digits` is a string of up to 15 digits.
function wholeWords(digits: string): string {
  let n = BigInt(digits);
  if (n === 0n) return ONES[0];
  const groups: number[] = [];
  while (n > 0n) {
    groups.push(Number(n % 1000n));
    n /= 1000n;
  }
  const parts: string[] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    if (!g) continue;
    let w = underThousand(g);
    if (i > 0) w += ` ${SCALES[i]}`;
    // "one thousand and one", "one million and ten": "and" before a final group under 100
    if (i === 0 && g < 100 && parts.length) w = `and ${w}`;
    parts.push(w);
  }
  return parts.join(' ');
}

/**
 * @param amount decimal string such as "12500.00" (1 to 15 digits, up to 2 decimals)
 * @param currency ISO 4217 code
 * @returns the words, or null if the amount isn't a valid positive figure
 */
export function amountInWords(amount: string, currency: string): string | null {
  const m = /^(\d{1,15})(?:\.(\d{1,2}))?$/.exec(amount.trim());
  if (!m) return null;
  const whole = m[1].replace(/^0+(?=\d)/, '');
  const minorN = Number((m[2] ?? '').padEnd(2, '0') || '0');
  if (BigInt(whole) === 0n && minorN === 0) return null;

  const code = currency.trim().toUpperCase();
  const unit = UNITS[code];
  const parts: string[] = [];

  if (BigInt(whole) > 0n) {
    const noun = unit ? (BigInt(whole) === 1n ? unit.major[0] : unit.major[1]) : code;
    parts.push(`${wholeWords(whole)} ${noun}`);
  }
  if (minorN > 0) {
    if (unit?.minor) {
      parts.push(`${wholeWords(String(minorN))} ${minorN === 1 ? unit.minor[0] : unit.minor[1]}`);
    } else {
      // no known minor unit: fall back to the cheque form "and 50/100"
      parts.push(BigInt(whole) > 0n ? `${String(minorN).padStart(2, '0')}/100` : `${String(minorN).padStart(2, '0')}/100 ${code}`);
    }
  }
  const text = parts.join(' and ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)} only`;
}
