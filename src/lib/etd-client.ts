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
