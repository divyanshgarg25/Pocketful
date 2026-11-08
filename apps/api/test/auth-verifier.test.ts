import { describe, it, expect, afterEach } from 'vitest';
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from 'jose';
import { verifyAccessToken, __setJwksForTests } from '../src/core/auth.js';
import { config } from '../src/core/config.js';

const SUB = '00000000-0000-4000-a000-0000000000aa';
const hmac = () => new TextEncoder().encode(config.SUPABASE_JWT_SECRET);
const base = (alg: string, kid?: string) => new SignJWT({ email: 'a@b.c' }).setProtectedHeader(kid ? { alg, kid } : { alg }).setSubject(SUB).setAudience('authenticated').setExpirationTime('1h');

describe('single pinned token verifier (D2)', () => {
  afterEach(() => __setJwksForTests(null));

  it('accepts a valid HS256 token', async () => {
    expect((await verifyAccessToken(await base('HS256').sign(hmac()))).userId).toBe(SUB);
  });

  it('rejects HS384/HS512 (algorithm is pinned, not just "whatever the secret verifies")', async () => {
    for (const alg of ['HS384', 'HS512']) {
      await expect(verifyAccessToken(await base(alg).sign(hmac()))).rejects.toThrow();
    }
  });

  it('rejects expired, wrong-audience and subject-less tokens', async () => {
    const expired = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(SUB).setAudience('authenticated').setExpirationTime(Math.floor(Date.now() / 1000) - 60).sign(hmac());
    await expect(verifyAccessToken(expired)).rejects.toThrow();
    const wrongAud = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(SUB).setAudience('somebody-else').setExpirationTime('1h').sign(hmac());
    await expect(verifyAccessToken(wrongAud)).rejects.toThrow();
    const noSub = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setAudience('authenticated').setExpirationTime('1h').sign(hmac());
    await expect(verifyAccessToken(noSub)).rejects.toThrow();
  });

  it('rejects alg=none and garbage', async () => {
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: SUB, aud: 'authenticated' })).toString('base64url')}.`;
    await expect(verifyAccessToken(none)).rejects.toThrow();
    await expect(verifyAccessToken('not.a.jwt')).rejects.toThrow();
  });

  it('accepts ES256 only through a trusted JWKS, and never when none is configured', async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    const jwk = { ...(await exportJWK(publicKey)), alg: 'ES256', use: 'sig', kid: 'k1' };
    const token = await base('ES256', 'k1').sign(privateKey);

    // no JWKS configured and no remote Supabase project in test: refuse
    await expect(verifyAccessToken(token)).rejects.toThrow();

    __setJwksForTests(createLocalJWKSet({ keys: [jwk] }) as never);
    expect((await verifyAccessToken(token)).userId).toBe(SUB);

    // a different key pair signing with the same kid must fail
    const other = await generateKeyPair('ES256');
    const forged = await base('ES256', 'k1').sign(other.privateKey);
    await expect(verifyAccessToken(forged)).rejects.toThrow();
  });

  it('an HS256 token signed with the PUBLIC key bytes (key-confusion) is rejected', async () => {
    const { publicKey } = await generateKeyPair('ES256');
    const jwk = await exportJWK(publicKey);
    const confused = await base('HS256').sign(new TextEncoder().encode(JSON.stringify(jwk)));
    await expect(verifyAccessToken(confused)).rejects.toThrow();
  });
});
