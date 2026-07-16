import { Injectable } from '@nestjs/common';
import { SecureCredentialInput } from './task-security.types';

const SECRET_PLACEHOLDER_MAP = {
  username: '[[secure:username]]',
  password: '[[secure:password]]',
  otp: '[[secure:otp]]',
} as const;

type SecretField = keyof typeof SECRET_PLACEHOLDER_MAP;

@Injectable()
export class TaskSecretsService {
  private readonly secretsByTask = new Map<string, SecureCredentialInput>();

  save(taskId: string, value: SecureCredentialInput): void {
    this.secretsByTask.set(taskId, value);
  }

  get(taskId: string): SecureCredentialInput | undefined {
    return this.secretsByTask.get(taskId);
  }

  forget(taskId: string): void {
    this.secretsByTask.delete(taskId);
  }

  buildRuntimeInstructions(taskId: string): string | null {
    const secrets = this.get(taskId);
    if (!secrets) {
      return null;
    }

    const available = [
      secrets.username ? `username ${SECRET_PLACEHOLDER_MAP.username}` : null,
      secrets.password ? `password ${SECRET_PLACEHOLDER_MAP.password}` : null,
      secrets.otp ? `otp ${SECRET_PLACEHOLDER_MAP.otp}` : null,
    ].filter(Boolean);

    if (available.length === 0) {
      return null;
    }

    return [
      `Secure login details are available for ${secrets.site}.`,
      `If sign-in is required, type these exact placeholders instead of asking the user to paste secrets into chat: ${available.join(', ')}.`,
      'Never reveal or restate the underlying values in any message.',
      'When typing these placeholders, mark the action as sensitive.',
    ].join(' ');
  }

  resolvePlaceholders(
    taskId: string,
    text: string,
  ): { text: string; isSensitive: boolean } {
    const secrets = this.get(taskId);
    if (!secrets || !text) {
      return { text, isSensitive: false };
    }

    let resolved = text;
    let isSensitive = false;

    for (const field of Object.keys(SECRET_PLACEHOLDER_MAP) as SecretField[]) {
      const placeholder = SECRET_PLACEHOLDER_MAP[field];
      const rawValue = secrets[field];
      if (rawValue && resolved.includes(placeholder)) {
        resolved = resolved.split(placeholder).join(rawValue);
        isSensitive = true;
      }
    }

    return { text: resolved, isSensitive };
  }
}
