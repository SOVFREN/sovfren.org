// Minimal Code 128 (subset B) encoder returning bar/space module widths, used
// to print the Companion Number as a barcode on the ID card.
const PATTERNS =
  '212222,222122,222221,121223,121322,131222,122213,122312,132212,221213,221312,231212,112232,122132,122231,113222,123122,123221,223211,221132,221231,213212,223112,312131,311222,321122,321221,312212,322112,322211,212123,212321,232121,111323,131123,131321,112313,132113,132311,211313,231113,231311,112133,112331,132131,113123,113321,133121,313121,211331,231131,213113,213311,213131,311123,311321,331121,312113,312311,332111,314111,221411,431111,111224,111422,121124,121421,141122,141221,112214,112412,122114,122411,142112,142211,241211,221114,413111,241112,134111,111242,121142,121241,114212,124112,124211,411212,421112,421211,212141,214121,412121,111143,111341,131141,114113,114311,411113,411311,113141,114131,311141,411131,211412,211214,211232,2331112'.split(',');

const START_B = 104;
const STOP = 106;

export interface BarcodeBar {
  x: number;
  width: number;
}

export function code128B(text: string): { bars: BarcodeBar[]; width: number } {
  const codes = [START_B];
  for (const ch of text) {
    const code = ch.charCodeAt(0) - 32;
    if (code < 0 || code > 94) throw new Error(`Unsupported barcode character: ${ch}`);
    codes.push(code);
  }
  const checksum = codes.reduce((sum, code, i) => sum + code * (i === 0 ? 1 : i), 0) % 103;
  codes.push(checksum, STOP);

  const bars: BarcodeBar[] = [];
  let x = 0;
  for (const code of codes) {
    [...PATTERNS[code]].forEach((w, i) => {
      const width = Number(w);
      if (i % 2 === 0) bars.push({ x, width });
      x += width;
    });
  }
  return { bars, width: x };
}
