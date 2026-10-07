import { randomUUID } from 'node:crypto';
import { decrypt, encrypt } from '@onebox/crypto';
import { isUniqueViolation } from '@onebox/db-pg';
import { ConflictError, NotFoundError, UnprocessableError } from '@onebox/errors';
import type { Logger } from '@onebox/logger';
import { and, asc, count, eq, ne, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { emailAccounts, type EmailAccountRow } from '../db/schema';
import { PRESETS, type PresetProvider, type ServerSettings } from '../imap/presets';
import type { ImapVerifier, VerifyResult } from '../imap/verify-imap';

export type CreateAccountInput =
  | {
      provider: PresetProvider;
      emailAddress: string;
      displayName?: string | undefined;
      password: string;
    }
  | {
      provider: 'IMAP';
      emailAddress: string;
      displayName?: string | undefined;
      username?: string | undefined;
      password: string;
      imap: ServerSettings;
      smtp?: ServerSettings | undefined;
    };

export interface UpdateAccountInput {
  displayName?: string | null | undefined;
  password?: string | undefined;
  enabled?: boolean | undefined;
}

export interface AccountServiceDeps {
  db: PostgresJsDatabase;
  encryptionKey: Buffer;
  verifyImap: ImapVerifier;
  logger: Logger;
  maxAccountsPerUser?: number;
}

export type AccountView = ReturnType<typeof toView>;

export function toView(row: EmailAccountRow) {
  return {
    id: row.id,
    provider: row.provider,
    emailAddress: row.emailAddress,
    displayName: row.displayName,
    username: row.username,
    imap: { host: row.imapHost, port: row.imapPort, tls: row.imapTls },
    smtp:
      row.smtpHost && row.smtpPort !== null && row.smtpTls !== null
        ? { host: row.smtpHost, port: row.smtpPort, tls: row.smtpTls }
        : null,
    status: row.status,
    lastError: row.lastError,
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// Binding the ciphertext to its account id stops it being copied onto another row.
const aadFor = (accountId: string) => `account:${accountId}`;

const statusFrom = (result: VerifyResult) =>
  result.ok
    ? { status: 'CONNECTED' as const, lastError: null }
    : { status: result.reason, lastError: result.message };

function connectionFailed(result: Exclude<VerifyResult, { ok: true }>) {
  return new UnprocessableError(result.message, {
    code: 'CONNECTION_FAILED',
    details: { reason: result.reason },
  });
}

export function createAccountService({
  db,
  encryptionKey,
  verifyImap,
  logger,
  maxAccountsPerUser = 20,
}: AccountServiceDeps) {
  async function findOwned(userId: string, accountId: string): Promise<EmailAccountRow> {
    const [row] = await db
      .select()
      .from(emailAccounts)
      .where(and(eq(emailAccounts.id, accountId), eq(emailAccounts.userId, userId)));
    // Another user's account is reported as missing so ids cannot be probed.
    if (!row) throw new NotFoundError('Account not found');
    return row;
  }

  const imapOf = (row: EmailAccountRow, password: string) => ({
    host: row.imapHost,
    port: row.imapPort,
    tls: row.imapTls,
    username: row.username,
    password,
  });

  async function save(row: EmailAccountRow, changes: Partial<EmailAccountRow>) {
    const [updated] = await db
      .update(emailAccounts)
      .set(changes)
      .where(eq(emailAccounts.id, row.id))
      .returning();
    return updated!;
  }

  return {
    async list(userId: string): Promise<AccountView[]> {
      const rows = await db
        .select()
        .from(emailAccounts)
        .where(eq(emailAccounts.userId, userId))
        .orderBy(asc(emailAccounts.createdAt));
      return rows.map(toView);
    },

    async get(userId: string, accountId: string): Promise<AccountView> {
      return toView(await findOwned(userId, accountId));
    },

    async create(userId: string, input: CreateAccountInput): Promise<AccountView> {
      const [{ total } = { total: 0 }] = await db
        .select({ total: count() })
        .from(emailAccounts)
        .where(eq(emailAccounts.userId, userId));
      if (total >= maxAccountsPerUser) {
        throw new ConflictError(`You can connect up to ${maxAccountsPerUser} accounts`, {
          code: 'ACCOUNT_LIMIT_REACHED',
        });
      }

      const servers =
        input.provider === 'IMAP'
          ? { imap: input.imap, smtp: input.smtp }
          : { imap: PRESETS[input.provider].imap, smtp: PRESETS[input.provider].smtp };
      const username = (input.provider === 'IMAP' && input.username) || input.emailAddress;

      const result = await verifyImap({ ...servers.imap, username, password: input.password });
      if (!result.ok) throw connectionFailed(result);

      const id = randomUUID();
      try {
        const [row] = await db
          .insert(emailAccounts)
          .values({
            id,
            userId,
            provider: input.provider,
            emailAddress: input.emailAddress,
            displayName: input.displayName ?? null,
            imapHost: servers.imap.host,
            imapPort: servers.imap.port,
            imapTls: servers.imap.tls,
            smtpHost: servers.smtp?.host ?? null,
            smtpPort: servers.smtp?.port ?? null,
            smtpTls: servers.smtp?.tls ?? null,
            username,
            credentialsEncrypted: encrypt(input.password, encryptionKey, aadFor(id)),
            lastVerifiedAt: new Date(),
          })
          .returning();
        logger.info({ userId, accountId: id, provider: input.provider }, 'account connected');
        return toView(row!);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictError('This mailbox is already connected', { code: 'ACCOUNT_EXISTS' });
        }
        throw err;
      }
    },

    async update(
      userId: string,
      accountId: string,
      input: UpdateAccountInput,
    ): Promise<AccountView> {
      const row = await findOwned(userId, accountId);
      const changes: Partial<EmailAccountRow> = {};

      if (input.displayName !== undefined) changes.displayName = input.displayName;

      if (input.password !== undefined) {
        const result = await verifyImap(imapOf(row, input.password));
        if (!result.ok) throw connectionFailed(result);
        changes.credentialsEncrypted = encrypt(input.password, encryptionKey, aadFor(row.id));
        Object.assign(changes, statusFrom(result), { lastVerifiedAt: new Date() });
      }

      if (input.enabled === false) {
        changes.status = 'DISABLED';
      } else if (input.enabled === true && row.status === 'DISABLED' && !input.password) {
        const password = decrypt(row.credentialsEncrypted, encryptionKey, aadFor(row.id));
        Object.assign(changes, statusFrom(await verifyImap(imapOf(row, password))), {
          lastVerifiedAt: new Date(),
        });
      }

      if (Object.keys(changes).length === 0) return toView(row);
      const updated = await save(row, changes);
      logger.info({ userId, accountId, status: updated.status }, 'account updated');
      return toView(updated);
    },

    async test(userId: string, accountId: string) {
      const row = await findOwned(userId, accountId);
      const password = decrypt(row.credentialsEncrypted, encryptionKey, aadFor(row.id));
      const result = await verifyImap(imapOf(row, password));
      const updated = await save(row, {
        ...(row.status !== 'DISABLED' && statusFrom(result)),
        lastVerifiedAt: new Date(),
      });
      return { result, account: toView(updated) };
    },

    // Internal: accounts the connector should keep a live mailbox connection for.
    async listActive() {
      const rows = await db
        .select()
        .from(emailAccounts)
        .where(ne(emailAccounts.status, 'DISABLED'));
      return rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        provider: row.provider,
        emailAddress: row.emailAddress,
        status: row.status,
        updatedAt: row.updatedAt.toISOString(),
        syncState: row.syncState as Record<string, unknown>,
      }));
    },

    async getCredentials(accountId: string) {
      const [row] = await db.select().from(emailAccounts).where(eq(emailAccounts.id, accountId));
      if (!row) throw new NotFoundError('Account not found');
      return {
        ...imapOf(row, decrypt(row.credentialsEncrypted, encryptionKey, aadFor(row.id))),
        userId: row.userId,
      };
    },

    async saveSyncState(accountId: string, folder: string, state: Record<string, unknown>) {
      const updated = await db
        .update(emailAccounts)
        .set({
          syncState: sql`jsonb_set(${emailAccounts.syncState}, ARRAY[${folder}]::text[], ${JSON.stringify(state)}::jsonb)`,
        })
        .where(eq(emailAccounts.id, accountId))
        .returning({ id: emailAccounts.id });
      if (updated.length === 0) throw new NotFoundError('Account not found');
    },

    // A paused account stays paused even if the connector reports on it.
    async reportStatus(
      accountId: string,
      status: Exclude<EmailAccountRow['status'], 'DISABLED'>,
      lastError: string | null,
    ) {
      const [row] = await db
        .update(emailAccounts)
        .set({ status, lastError, lastVerifiedAt: new Date() })
        .where(and(eq(emailAccounts.id, accountId), ne(emailAccounts.status, 'DISABLED')))
        .returning();
      if (row) logger.info({ accountId, status }, 'account status reported by connector');
    },

    async remove(userId: string, accountId: string): Promise<void> {
      const deleted = await db
        .delete(emailAccounts)
        .where(and(eq(emailAccounts.id, accountId), eq(emailAccounts.userId, userId)))
        .returning({ id: emailAccounts.id });
      if (deleted.length === 0) throw new NotFoundError('Account not found');
      logger.info({ userId, accountId }, 'account removed');
    },
  };
}

export type AccountService = ReturnType<typeof createAccountService>;
