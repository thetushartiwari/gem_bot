import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

type EncryptedPayload = {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: number;
};

@Injectable()
export class BrowserSessionCryptoService {
  private readonly keyVersion: number;

  constructor(private readonly configService: ConfigService) {
    this.keyVersion = Number(
      this.configService.get<string>('BROWSER_SESSION_KEY_VERSION') ||
        process.env.BROWSER_SESSION_KEY_VERSION ||
        '1',
    );
  }

  encryptArchive(plainArchive: string): EncryptedPayload {
    return this.encryptString(plainArchive);
  }

  decryptArchive(input: {
    ciphertext: Buffer;
    iv: Buffer;
    authTag?: Buffer | null;
  }): string {
    return this.decryptString(input);
  }

  encryptJson(value: unknown): EncryptedPayload {
    return this.encryptString(JSON.stringify(value));
  }

  decryptJson<T>(input: {
    ciphertext: Buffer;
    iv: Buffer;
    authTag?: Buffer | null;
  }): T {
    return JSON.parse(this.decryptString(input)) as T;
  }

  private encryptString(plainText: string): EncryptedPayload {
    const key = this.resolveKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plainText, 'utf8'),
      cipher.final(),
    ]);

    return {
      ciphertext,
      iv,
      authTag: cipher.getAuthTag(),
      keyVersion: this.keyVersion,
    };
  }

  private decryptString(input: {
    ciphertext: Buffer;
    iv: Buffer;
    authTag?: Buffer | null;
  }): string {
    const key = this.resolveKey();
    if (!input.authTag) {
      throw new Error('Missing browser session authentication tag');
    }

    const decipher = createDecipheriv('aes-256-gcm', key, input.iv);
    decipher.setAuthTag(input.authTag);

    return Buffer.concat([
      decipher.update(input.ciphertext),
      decipher.final(),
    ]).toString('utf8');
  }

  private resolveKey(): Buffer {
    const raw =
      this.configService.get<string>('BROWSER_SESSION_ENCRYPTION_KEY') ||
      process.env.BROWSER_SESSION_ENCRYPTION_KEY ||
      '';

    if (!raw) {
      throw new Error(
        'BROWSER_SESSION_ENCRYPTION_KEY is required for encrypted browser session storage',
      );
    }

    const trimmed = raw.trim();
    const base64Candidate = this.tryDecode(trimmed, 'base64');
    if (base64Candidate?.length === 32) {
      return base64Candidate;
    }

    const hexCandidate = this.tryDecode(trimmed, 'hex');
    if (hexCandidate?.length === 32) {
      return hexCandidate;
    }

    const utf8Candidate = Buffer.from(trimmed, 'utf8');
    if (utf8Candidate.length === 32) {
      return utf8Candidate;
    }

    throw new Error(
      'BROWSER_SESSION_ENCRYPTION_KEY must decode to exactly 32 bytes (base64, hex, or raw 32-char string)',
    );
  }

  private tryDecode(
    value: string,
    encoding: BufferEncoding,
  ): Buffer | null {
    try {
      const decoded = Buffer.from(value, encoding);
      return decoded.length > 0 ? decoded : null;
    } catch {
      return null;
    }
  }
}
