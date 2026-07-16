import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { BrowserSessionCryptoService } from './browser-session-crypto.service';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  BrowserKind,
  BrowserSessionMetadata,
  SavedBrowserSessionInput,
  SecureCredentialInput,
} from './task-security.types';

type LegacyBrowserSessionManifest = BrowserSessionMetadata & {
  archivePath: string;
};

export type SavedAuthMatch = {
  label: string;
  site?: string;
  browser?: BrowserKind;
  hasCredential: boolean;
  hasBrowserSession: boolean;
  updatedAt: string;
};

type SavedAuthResolutionMode =
  | 'explicit_auth'
  | 'open_existing_account_surface'
  | 'generic_browser_task';

const LEGACY_MANIFEST_FILE = 'manifest.json';
const DEFAULT_BROWSER: BrowserKind = 'brave';

@Injectable()
export class BrowserSessionsService {
  private readonly logger = new Logger(BrowserSessionsService.name);
  private readonly desktopBaseUrl: string;
  private readonly legacyBaseDir: string;
  private readonly genericAuthTokens = new Set([
    'www',
    'com',
    'org',
    'net',
    'app',
    'web',
    'site',
    'saved',
    'session',
    'account',
    'testing',
    'allyra',
  ]);

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly cryptoService: BrowserSessionCryptoService,
  ) {
    this.desktopBaseUrl =
      this.configService.get<string>('BYTEBOT_DESKTOP_BASE_URL') ||
      process.env.BYTEBOT_DESKTOP_BASE_URL ||
      '';
    this.legacyBaseDir = path.join(process.cwd(), 'data', 'browser-sessions');
  }

  async list(): Promise<BrowserSessionMetadata[]> {
    await this.migrateLegacySessionsIfNeeded();

    const [sessions, credentials] = await Promise.all([
      this.prisma.browserSession.findMany({
        orderBy: { updatedAt: 'desc' },
      }),
      this.prisma.browserCredential.findMany({
        select: { label: true, site: true, createdAt: true, updatedAt: true },
      }),
    ]);

    const sessionByLabel = new Map(sessions.map((session) => [session.label, session]));
    const credentialByLabel = new Map(
      credentials.map((credential) => [credential.label, credential]),
    );
    const labels = Array.from(
      new Set([
        ...sessions.map((session) => session.label),
        ...credentials.map((credential) => credential.label),
      ]),
    );

    return labels
      .map((label) => {
        const session = sessionByLabel.get(label);
        const credential = credentialByLabel.get(label);
        const createdAt = session?.createdAt || credential?.createdAt || new Date();
        const updatedAt =
          session && credential
            ? new Date(
                Math.max(
                  session.updatedAt.getTime(),
                  credential.updatedAt.getTime(),
                ),
              )
            : session?.updatedAt || credential?.updatedAt || createdAt;

        return {
          label,
          site: credential?.site || session?.site || undefined,
          ...(session && { browser: this.normalizeBrowser(session.browser) }),
          createdAt: createdAt.toISOString(),
          updatedAt: updatedAt.toISOString(),
          hasCredential: Boolean(credential),
        };
      })
      .sort(
        (left, right) =>
          new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
      );
  }

  async resolveSavedAuthForTask(
    description: string,
    preferredSite?: string,
    mode: SavedAuthResolutionMode = 'generic_browser_task',
  ): Promise<SavedAuthMatch | null> {
    await this.migrateLegacySessionsIfNeeded();

    const [sessions, credentials] = await Promise.all([
      this.prisma.browserSession.findMany({
        orderBy: { updatedAt: 'desc' },
      }),
      this.prisma.browserCredential.findMany({
        select: { label: true, site: true, updatedAt: true },
      }),
    ]);

    const sessionByLabel = new Map(sessions.map((session) => [session.label, session]));
    const credentialByLabel = new Map(
      credentials.map((credential) => [credential.label, credential]),
    );
    const candidateLabels = new Set([
      ...sessionByLabel.keys(),
      ...credentialByLabel.keys(),
    ]);

    if (candidateLabels.size === 0) {
      return null;
    }

    const taskText = `${preferredSite || ''} ${description}`.trim().toLowerCase();
    const candidates = Array.from(candidateLabels).map((label) => {
      const session = sessionByLabel.get(label);
      const credential = credentialByLabel.get(label);
      const updatedAt = session?.updatedAt || credential?.updatedAt || new Date(0);

      return {
        label,
        site: credential?.site || session?.site || undefined,
        browser: this.normalizeBrowser(session?.browser),
        hasCredential: Boolean(credential),
        hasBrowserSession: Boolean(session),
        updatedAt,
      };
    });

    const scored = candidates
      .map((candidate) => ({
        candidate,
        score: this.scoreSavedAuthCandidate(
          candidate.label,
          candidate.site,
          taskText,
          preferredSite,
          candidate.hasCredential,
          candidate.hasBrowserSession,
        ),
      }))
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return right.candidate.updatedAt.getTime() - left.candidate.updatedAt.getTime();
      });

    const best = scored[0];
    if (!best) {
      return null;
    }

    const minimumScore =
      mode === 'explicit_auth' ? 1 : mode === 'open_existing_account_surface' ? 8 : 10;
    if (best.score < minimumScore) {
      if (
        mode === 'explicit_auth' &&
        candidates.length === 1 &&
        this.looksLikeTaskMayNeedSavedAuth(taskText, candidates[0].site)
      ) {
        return {
          label: candidates[0].label,
          site: candidates[0].site,
          browser: candidates[0].browser,
          updatedAt: candidates[0].updatedAt.toISOString(),
          hasCredential: candidates[0].hasCredential,
          hasBrowserSession: candidates[0].hasBrowserSession,
        };
      }
      return null;
    }

    if (mode === 'generic_browser_task' && !best.candidate.hasBrowserSession) {
      return null;
    }

    const secondBest = scored[1];
    if (
      secondBest &&
      secondBest.score === best.score &&
      best.score < (mode === 'generic_browser_task' ? 14 : 12)
    ) {
      this.logger.warn(
        `Saved auth resolution is ambiguous for task "${description}". Top candidates: ${best.candidate.label}, ${secondBest.candidate.label}`,
      );
      return null;
    }

    return {
      label: best.candidate.label,
      site: best.candidate.site,
      browser: best.candidate.browser,
      updatedAt: best.candidate.updatedAt.toISOString(),
      hasCredential: best.candidate.hasCredential,
      hasBrowserSession: best.candidate.hasBrowserSession,
    };
  }

  async delete(label: string): Promise<boolean> {
    const safeLabel = this.normalizeLabel(label);
    if (!safeLabel) {
      return false;
    }

    const [deletedSessions, deletedCredentials] = await this.prisma.$transaction([
      this.prisma.browserSession.deleteMany({
        where: { label: safeLabel },
      }),
      this.prisma.browserCredential.deleteMany({
        where: { label: safeLabel },
      }),
    ]);

    if (deletedSessions.count === 0 && deletedCredentials.count === 0) {
      this.logger.warn(`No saved browser session found to delete for ${safeLabel}`);
      return false;
    }

    this.logger.log(`Deleted saved browser session and credentials for ${safeLabel}`);
    return true;
  }

  async saveCredential(
    label: string,
    credential: SecureCredentialInput,
  ): Promise<void> {
    const safeLabel = this.normalizeLabel(label);
    if (!safeLabel) {
      return;
    }

    const encrypted = this.cryptoService.encryptJson({
      site: credential.site,
      username: credential.username || null,
      password: credential.password || null,
      otp: credential.otp || null,
    });

    await this.prisma.browserCredential.upsert({
      where: { label: safeLabel },
      update: {
        site: credential.site,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        keyVersion: encrypted.keyVersion,
      },
      create: {
        label: safeLabel,
        site: credential.site,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        keyVersion: encrypted.keyVersion,
      },
    });

    this.logger.log(`Saved encrypted browser credentials for ${safeLabel}`);
  }

  async loadCredential(label: string): Promise<SecureCredentialInput | null> {
    const safeLabel = this.normalizeLabel(label);
    if (!safeLabel) {
      return null;
    }

    const record = await this.prisma.browserCredential.findUnique({
      where: { label: safeLabel },
    });

    if (!record) {
      return null;
    }

    const decrypted = this.cryptoService.decryptJson<{
      site: string;
      username?: string | null;
      password?: string | null;
      otp?: string | null;
    }>({
      ciphertext: Buffer.from(record.ciphertext),
      iv: Buffer.from(record.iv),
      authTag: record.authTag ? Buffer.from(record.authTag) : null,
    });

    return {
      site: decrypted.site,
      username: decrypted.username || undefined,
      password: decrypted.password || undefined,
      otp: decrypted.otp || undefined,
      mode: 'save_for_later',
      sessionLabel: safeLabel,
    };
  }

  async restore(input: SavedBrowserSessionInput): Promise<boolean> {
    const label = this.normalizeLabel(input.label);
    if (!label) {
      return false;
    }

    let session = await this.prisma.browserSession.findUnique({
      where: { label },
    });

    if (!session) {
      session = await this.importLegacySession(label);
    }

    if (!session) {
      this.logger.warn(`No saved browser session found for ${label}`);
      return false;
    }

    const archive = this.cryptoService.decryptArchive({
      ciphertext: Buffer.from(session.ciphertext),
      iv: Buffer.from(session.iv),
      authTag: session.authTag ? Buffer.from(session.authTag) : null,
    });

    const normalizedBrowser = this.normalizeBrowser(input.browser || session.browser);

    const response = await this.desktopRequest({
      action: 'browser_session_import',
      archive,
      browser: normalizedBrowser,
    });

    await this.prisma.browserSession.update({
      where: { label },
      data: {
        browser: normalizedBrowser,
        lastUsedAt: new Date(),
      },
    });

    this.logger.log(
      `Restored browser session ${label}: ${response.message || 'ok'}`,
    );
    return true;
  }

  async saveCurrent(
    label: string,
    site?: string,
    browser: BrowserKind = DEFAULT_BROWSER,
  ): Promise<BrowserSessionMetadata | null> {
    const safeLabel = this.normalizeLabel(label);
    if (!safeLabel) {
      return null;
    }

    const normalizedBrowser = this.normalizeBrowser(browser);

    const response = await this.desktopRequest({
      action: 'browser_session_export',
      browser: normalizedBrowser,
    });

    if (!response?.archive) {
      throw new Error('Desktop returned no browser session archive');
    }

    const encrypted = this.cryptoService.encryptArchive(response.archive);

    const saved = await this.prisma.browserSession.upsert({
      where: { label: safeLabel },
      update: {
        site,
        browser: normalizedBrowser,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        keyVersion: encrypted.keyVersion,
        encoding: 'base64-archive',
        updatedAt: new Date(),
      },
      create: {
        label: safeLabel,
        site,
        browser: normalizedBrowser,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        keyVersion: encrypted.keyVersion,
        encoding: 'base64-archive',
      },
    });

    this.logger.log(`Saved browser session ${safeLabel} to encrypted Postgres storage`);
    return {
      label: saved.label,
      site: saved.site || undefined,
      browser: this.normalizeBrowser(saved.browser),
      createdAt: saved.createdAt.toISOString(),
      updatedAt: saved.updatedAt.toISOString(),
    };
  }

  async clearDesktopSession(browser: BrowserKind = DEFAULT_BROWSER): Promise<void> {
    const normalizedBrowser = this.normalizeBrowser(browser);

    await this.desktopRequest({
      action: 'browser_session_clear',
      browser: normalizedBrowser,
    });
    this.logger.log(`Cleared live ${normalizedBrowser} browser session`);
  }

  private async migrateLegacySessionsIfNeeded(): Promise<void> {
    await this.migrateStoredBrowsersToDefault();

    const manifest = await this.readLegacyManifest();
    const labels = Object.keys(manifest);
    if (labels.length === 0) {
      return;
    }

    for (const label of labels) {
      const existing = await this.prisma.browserSession.findUnique({
        where: { label },
      });
      if (existing) {
        continue;
      }

      await this.importLegacySession(label, manifest[label]);
    }
  }

  private async importLegacySession(
    label: string,
    record?: LegacyBrowserSessionManifest,
  ) {
    const manifestRecord = record || (await this.readLegacyManifest())[label];
    if (!manifestRecord) {
      return null;
    }

    const archive = await fs.readFile(manifestRecord.archivePath, 'utf8');
    const encrypted = this.cryptoService.encryptArchive(archive);

    const imported = await this.prisma.browserSession.upsert({
      where: { label },
      update: {
        site: manifestRecord.site,
        browser: DEFAULT_BROWSER,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        keyVersion: encrypted.keyVersion,
        encoding: 'base64-archive',
        updatedAt: new Date(manifestRecord.updatedAt),
      },
      create: {
        label,
        site: manifestRecord.site,
        browser: DEFAULT_BROWSER,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        keyVersion: encrypted.keyVersion,
        encoding: 'base64-archive',
        createdAt: new Date(manifestRecord.createdAt),
        updatedAt: new Date(manifestRecord.updatedAt),
      },
    });

    this.logger.log(`Imported legacy browser session ${label} into Postgres storage`);
    return imported;
  }

  private async readLegacyManifest(): Promise<
    Record<string, LegacyBrowserSessionManifest>
  > {
    try {
      const raw = await fs.readFile(
        path.join(this.legacyBaseDir, LEGACY_MANIFEST_FILE),
        'utf8',
      );
      return JSON.parse(raw) as Record<string, LegacyBrowserSessionManifest>;
    } catch {
      return {};
    }
  }

  private normalizeLabel(label: string): string {
    return label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);
  }

  private normalizeBrowser(_browser?: string | null): BrowserKind {
    return DEFAULT_BROWSER;
  }

  private async migrateStoredBrowsersToDefault(): Promise<void> {
    const migrated = await this.prisma.browserSession.updateMany({
      where: { browser: 'firefox' },
      data: { browser: DEFAULT_BROWSER },
    });

    if (migrated.count > 0) {
      this.logger.log(
        `Migrated ${migrated.count} saved browser session record(s) from firefox to ${DEFAULT_BROWSER}`,
      );
    }
  }

  private looksLikeTaskMayNeedSavedAuth(
    taskText: string,
    site?: string | null,
  ): boolean {
    if (!taskText) {
      return false;
    }

    const authKeywords = [
      'sign in',
      'login',
      'log in',
      'inbox',
      'email',
      'mail',
      'gmail',
      'outlook',
      'hotmail',
      'github',
      'calendar',
      'drive',
      'meet',
      'teams',
      'youtube',
      'account',
      'message',
      'send mail',
    ];

    if (authKeywords.some((keyword) => taskText.includes(keyword))) {
      return true;
    }

    const siteTokens = this.extractMatchingTokens(site || '');
    return siteTokens.some((token) => taskText.includes(token));
  }

  private scoreSavedAuthCandidate(
    label: string,
    site: string | null | undefined,
    taskText: string,
    preferredSite?: string,
    hasCredential = false,
    hasBrowserSession = false,
  ): number {
    if (!taskText) {
      return 0;
    }

    const tokens = new Set([
      ...this.extractMatchingTokens(label),
      ...this.extractMatchingTokens(site || ''),
    ]);

    let score = 0;
    for (const token of tokens) {
      if (taskText.includes(token)) {
        score += token.length >= 5 ? 8 : 4;
      }
    }

    score += this.scoreAuthFamilyBonus(label, site, taskText);

    if (preferredSite) {
      const normalizedPreferred = preferredSite.toLowerCase();
      if (site?.toLowerCase() === normalizedPreferred) {
        score += 20;
      } else if (site?.toLowerCase().includes(normalizedPreferred)) {
        score += 12;
      }
    }

    if (site) {
      const normalizedSite = site.toLowerCase();
      if (
        (taskText.includes('gmail') || taskText.includes('inbox') || taskText.includes('email')) &&
        (normalizedSite.includes('gmail') || normalizedSite.includes('google mail'))
      ) {
        score += 12;
      }

      if (
        taskText.includes('github') &&
        normalizedSite.includes('github')
      ) {
        score += 12;
      }

      if (
        (taskText.includes('proton') || taskText.includes('protonmail')) &&
        normalizedSite.includes('proton')
      ) {
        score += 12;
      }
    }

    if (hasCredential) {
      score += 3;
    }

    if (hasBrowserSession) {
      score += 1;
    }

    return score;
  }

  private scoreAuthFamilyBonus(
    label: string,
    site: string | null | undefined,
    taskText: string,
  ): number {
    const targetText = `${label} ${site || ''}`.toLowerCase();
    let score = 0;

    if (this.matchesGoogleAuthFamily(targetText)) {
      if (
        /\b(gmail|google mail|google workspace|google account|google meet|meet|google calendar|google drive|youtube|accounts\.google\.com|google)\b/.test(
          taskText,
        )
      ) {
        score += 16;
      } else if (/\b(mail|email|inbox|calendar|drive)\b/.test(taskText)) {
        score += 6;
      }
    }

    if (this.matchesMicrosoftAuthFamily(targetText)) {
      if (/\b(outlook|hotmail|microsoft|office ?365|teams|live\.com)\b/.test(taskText)) {
        score += 16;
      } else if (/\b(mail|email|inbox)\b/.test(taskText)) {
        score += 6;
      }
    }

    return score;
  }

  private matchesGoogleAuthFamily(value: string): boolean {
    return /\b(google|gmail|google mail|google workspace|google meet|meet|youtube)\b/.test(
      value,
    ) || value.includes('accounts.google.com');
  }

  private matchesMicrosoftAuthFamily(value: string): boolean {
    return /\b(microsoft|outlook|hotmail|office ?365|teams)\b/.test(value) ||
      value.includes('live.com');
  }

  private extractMatchingTokens(value: string): string[] {
    return value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((token) => token.trim())
      .filter(
        (token) =>
          token.length >= 3 && !this.genericAuthTokens.has(token),
      );
  }

  private async desktopRequest(
    payload: Record<string, unknown>,
  ): Promise<Record<string, any>> {
    if (!this.desktopBaseUrl) {
      throw new Error('BYTEBOT_DESKTOP_BASE_URL is not configured');
    }

    const response = await fetch(`${this.desktopBaseUrl}/computer-use`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(
        `Desktop browser session request failed: ${response.statusText}`,
      );
    }

    return response.json();
  }
}
