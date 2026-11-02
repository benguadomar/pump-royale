// Solana wallet addresses are base58-encoded 32-byte ed25519 public keys (32–44 characters).
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Number of bytes `s` decodes to in base58, or -1 if it isn't base58. */
function base58Length(s) {
  const bytes = [0];
  for (const ch of s) {
    let carry = B58.indexOf(ch);
    if (carry < 0) return -1;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let zeros = 0;
  while (s[zeros] === '1') zeros++;
  // A leading zero byte from the initial [0] is not part of the value.
  const body = bytes.length === 1 && bytes[0] === 0 ? 0 : bytes.length;
  return zeros + body;
}

/** The trimmed address if it is a valid Solana public key, else null. */
export function cleanSolanaAddress(raw) {
  const s = String(raw ?? '').trim();
  return B58_RE.test(s) && base58Length(s) === 32 ? s : null;
}

export const shortAddress = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;
