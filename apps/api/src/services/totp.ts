import crypto from 'crypto';

/**
 * Minimal RFC 6238 TOTP (HMAC-SHA1, 30 s step, 6 digits: what every authenticator app supports) plus
 * AES-256-GCM sealing of the shared secret at rest. No third-party dependency; nothing here logs.
 */

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/g, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 4226 HOTP with dynamic truncation. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secret).update(msg).digest();
  const offset = h[h.length - 1]! & 0x0f;
  const bin =
    ((h[offset]! & 0x7f) << 24) | (h[offset + 1]! << 16) | (h[offset + 2]! << 8) | h[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export function totpStep(nowMs: number, period = TOTP_PERIOD_SECONDS): number {
  return Math.floor(nowMs / 1000 / period);
}

/**
 * Returns the matched time step (so the caller can refuse replays of the same step), or null.
 * Accepts the current step and +/- `window` steps of clock skew. Every candidate is compared in constant time
 * and the loop never exits early, so timing does not reveal which step (if any) matched.
 */
export function matchTotp(secret: Buffer, code: string, nowMs: number, window = 1): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const given = Buffer.from(code);
  const current = totpStep(nowMs);
  let matched: number | null = null;
  for (let s = current - window; s <= current + window; s++) {
    if (s < 0) continue;
    const candidate = Buffer.from(hotp(secret, s));
    if (crypto.timingSafeEqual(candidate, given)) matched = s;
  }
  return matched;
}

export function generateTotpSecret(): Buffer {
  return crypto.randomBytes(20); // 160 bits, the RFC 4226 recommendation
}

export function buildOtpAuthUri(secretBase32: string, accountLabel: string, issuer = 'Pocketful'): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountLabel)}`;
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS)
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ---------------------------------------------------------------------------------------------------------
// Secret sealing: v1.<iv>.<tag>.<ciphertext> (all base64url). AES-256-GCM, fresh 96-bit IV per seal.
// ---------------------------------------------------------------------------------------------------------

function keyFromHex(hexKey: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hexKey)) throw new Error('step-up encryption key must be 32 bytes of hex');
  return Buffer.from(hexKey, 'hex');
}

export function sealSecret(secret: Buffer, hexKey: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFromHex(hexKey), iv);
  const ct = Buffer.concat([cipher.update(secret), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

export function openSecret(sealed: string, hexKey: string): Buffer {
  const [ver, iv, tag, ct] = sealed.split('.');
  if (ver !== 'v1' || !iv || !tag || !ct) throw new Error('unrecognised sealed secret');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFromHex(hexKey), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]);
}
