// Browser-side holder keys for Electronic Trade Documents. Runs only in the
// browser (WebCrypto Ed25519): the private key never reaches the server.
//
// Key file: { format, publicKey, privateKey } where privateKey is either the
// PKCS8 key in base64, or { salt, iv, data } when protected by a passphrase
// (PBKDF2-SHA256 -> AES-GCM).

const b64 = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>;

async function wrapKey(passphrase: string, salt: Uint8Array<ArrayBuffer>) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 600_000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function generateKeyFile(passphrase: string): Promise<{ publicKey: string; file: string }> {
  let pair: CryptoKeyPair;
  try {
    pair = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair;
  } catch {
    throw new Error('This browser does not support Ed25519 keys. Use a current Chrome, Edge, Firefox or Safari.');
  }
  const publicKey = b64(await crypto.subtle.exportKey('raw', pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  let privateKey: unknown = b64(pkcs8);
  if (passphrase) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await wrapKey(passphrase, salt), pkcs8);
    privateKey = { salt: b64(salt), iv: b64(iv), data: b64(data) };
  }
  return { publicKey, file: JSON.stringify({ format: 'sovfren-etd-key-v1', publicKey, privateKey }, null, 2) };
}

async function loadKey(fileText: string, passphrase: string) {
  const f = JSON.parse(fileText);
  if (f?.format !== 'sovfren-etd-key-v1') throw new Error('That is not a Sovfren ETD key file.');
  let pkcs8: Uint8Array<ArrayBuffer>;
  if (typeof f.privateKey === 'string') {
    pkcs8 = unb64(f.privateKey);
  } else {
    if (!passphrase) throw new Error('This key file needs its passphrase.');
    try {
      pkcs8 = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: unb64(f.privateKey.iv) },
          await wrapKey(passphrase, unb64(f.privateKey.salt)),
          unb64(f.privateKey.data),
        ),
      );
    } catch {
      throw new Error('Wrong passphrase.');
    }
  }
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', false, ['sign']);
  return { key, publicKey: String(f.publicKey) };
}

// Signs `message` with the key file. Returns the signature and the public key
// it belongs to, so the page can warn before submitting if it isn't the holder's.
export async function signWithKeyFile(fileText: string, passphrase: string, message: string) {
  const { key, publicKey } = await loadKey(fileText, passphrase);
  const sig = await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(message));
  return { sig: b64(sig), publicKey };
}

// Must match actMessage() in etd.ts.
export const actMessage = (id: string, seq: string, prevHash: string, type: string, args: string[] = []) =>
  ['etd-act-v1', id, seq, prevHash, type, ...args].join('\n');

// One-time code for sending an instrument by email: 32 random bytes as hex, and its SHA-256 (what the holder signs).
export function randomToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Must match accessMessage() in etd.ts. What a holder signs to open their instrument's page without an account.
export const accessMessage = (serial: string, ts: string) => ['etd-access-v1', serial, ts].join('\n');

// Wires up the signed forms on the holder's own page (transfer, send by email, send by post, withdraw).
// Each form: `data-sign` says which act; the holder's key file and passphrase sign it in the browser.
export function wireHolderForms(ctx: { docId: string; docSeq: string; docPrev: string }) {
  document.querySelectorAll<HTMLFormElement>('form.signed').forEach((form) => {
    form.addEventListener('submit', async (ev) => {
      if (form.dataset.done) return;
      ev.preventDefault();
      const val = (n: string) => (form.elements.namedItem(n) as HTMLInputElement | null)?.value.trim() ?? '';
      const setField = (n: string, v: string) => ((form.elements.namedItem(n) as HTMLInputElement).value = v);
      const type = form.dataset.sign!;
      try {
        let args: string[] = [];
        let msgType = type;
        if (type === 'transfer') {
          args = [val('toName'), val('toRef'), val('toKey')];
        } else if (type === 'offer' || type === 'offer_post') {
          // A fresh one-time code, made here. The holder signs its fingerprint; the code itself goes only to the recipient.
          const token = randomToken();
          const tokenHash = await sha256Hex(token);
          const post = type === 'offer_post';
          const expiresAt = new Date(Date.now() + (post ? 28 : 14) * 864e5).toISOString();
          if (post && form.dataset.bearer !== '1') setField('toName', val('addressee'));
          setField('token', token);
          setField('tokenHash', tokenHash);
          setField('expiresAt', expiresAt);
          args = [tokenHash, expiresAt, val('toName'), val('toRef'), ...(post ? ['post'] : [])];
          msgType = 'offer';
        } else if (type === 'withdraw') {
          args = [form.dataset.tokenHash ?? ''];
        }
        const file = form.querySelector<HTMLInputElement>('.keyfile')!.files![0];
        const pass = form.querySelector<HTMLInputElement>('.pass')!.value;
        const { sig } = await signWithKeyFile(await file.text(), pass, actMessage(ctx.docId, ctx.docSeq, ctx.docPrev, msgType, args));
        setField('holderSig', sig);
        form.dataset.done = '1';
        form.submit();
      } catch (e) {
        alert(e instanceof Error ? e.message : 'Could not sign.');
      }
    });
  });
}
