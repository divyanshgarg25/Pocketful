import crypto from 'crypto';
import { isoCBOR, isoBase64URL } from '@simplewebauthn/server/helpers';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON
} from '@simplewebauthn/server';

/**
 * A software WebAuthn authenticator that produces REAL attestation/assertion objects (ES256 signatures over
 * authenticatorData || sha256(clientDataJSON), CBOR-encoded 'none' attestation). The server's verifier under test
 * is the genuine @simplewebauthn/server: nothing about verification is mocked.
 */
export class SoftwareAuthenticator {
  readonly credentialId = crypto.randomBytes(32);
  private readonly keys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  counter: number;

  constructor(
    private readonly rpId: string,
    private readonly origin: string,
    startCounter = 0
  ) {
    this.counter = startCounter;
  }

  get id(): string {
    return isoBase64URL.fromBuffer(new Uint8Array(this.credentialId));
  }

  private coseKey(): Uint8Array {
    const jwk = this.keys.publicKey.export({ format: 'jwk' });
    const m = new Map<number, number | Uint8Array>();
    m.set(1, 2); // kty: EC2
    m.set(3, -7); // alg: ES256
    m.set(-1, 1); // crv: P-256
    m.set(-2, new Uint8Array(Buffer.from(jwk.x as string, 'base64url')));
    m.set(-3, new Uint8Array(Buffer.from(jwk.y as string, 'base64url')));
    return isoCBOR.encode(m as never);
  }

  private rpIdHash(rpId = this.rpId): Buffer {
    return crypto.createHash('sha256').update(rpId).digest();
  }

  private counterBytes(n: number): Buffer {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  }

  /** Answers navigator.credentials.create(). */
  register(
    options: PublicKeyCredentialCreationOptionsJSON,
    opts: { userVerified?: boolean; origin?: string; rpId?: string } = {}
  ): RegistrationResponseJSON {
    const uv = opts.userVerified ?? true;
    const flags = 0x01 | (uv ? 0x04 : 0) | 0x40; // UP | UV | AT
    const credIdLen = Buffer.alloc(2);
    credIdLen.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      this.rpIdHash(opts.rpId),
      Buffer.from([flags]),
      this.counterBytes(this.counter),
      Buffer.alloc(16), // aaguid: all zero (no attestation)
      credIdLen,
      this.credentialId,
      Buffer.from(this.coseKey())
    ]);
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', new Uint8Array(authData)]
      ]) as never
    );
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: opts.origin ?? this.origin, crossOrigin: false })
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: clientDataJSON.toString('base64url'),
        attestationObject: Buffer.from(attestationObject).toString('base64url'),
        transports: ['internal']
      },
      clientExtensionResults: {}
    };
  }

  /** Answers navigator.credentials.get(). The signature is over whatever challenge the server issued. */
  assert(
    options: PublicKeyCredentialRequestOptionsJSON,
    opts: { userVerified?: boolean; origin?: string; rpId?: string; counter?: number; challenge?: string } = {}
  ): AuthenticationResponseJSON {
    const uv = opts.userVerified ?? true;
    this.counter = opts.counter ?? this.counter + 1;
    const flags = 0x01 | (uv ? 0x04 : 0);
    const authData = Buffer.concat([this.rpIdHash(opts.rpId), Buffer.from([flags]), this.counterBytes(this.counter)]);
    const clientDataJSON = Buffer.from(
      JSON.stringify({
        type: 'webauthn.get',
        challenge: opts.challenge ?? options.challenge,
        origin: opts.origin ?? this.origin,
        crossOrigin: false
      })
    );
    const clientDataHash = crypto.createHash('sha256').update(clientDataJSON).digest();
    const signature = crypto.sign('sha256', Buffer.concat([authData, clientDataHash]), {
      key: this.keys.privateKey,
      dsaEncoding: 'der'
    });
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: clientDataJSON.toString('base64url'),
        authenticatorData: authData.toString('base64url'),
        signature: signature.toString('base64url')
      },
      clientExtensionResults: {}
    };
  }
}
