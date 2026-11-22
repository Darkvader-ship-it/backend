/**
 * Erasure of a user's personal data (GDPR Article 17).
 *
 * What is erased and why:
 * - users: name and login email are replaced and the password hash is replaced
 *   with random bytes, so the account can never sign in again. The row stays,
 *   because sales (transactions.user_id) must keep pointing at a real user. Sales
 *   are kept for accounting, and the cashier name shows as "[deleted user]".
 * - user_totp: the 2FA secret, pending secret and recovery codes are deleted.
 * - audit_log: the email and IP of the user's rows are cleared. Action, path,
 *   status and time stay.
 * - queued emails (notifications and receipts queues): any job addressed to the
 *   user's email is removed, including ones waiting for retry or dead-lettered.
 *
 * Each erasure returns a receipt. The receipt lists the ids of the records that
 * changed and a SHA-256 digest over {subjectId, timestamp, records}. Anyone holding
 * the receipt can recompute the digest with verifyErasureReceipt() to confirm it
 * was not altered. The receipt holds no personal data.
 */
import { createHash, randomBytes } from 'node:crypto';
import { notFound } from '@/middleware/error.middleware';
import { AuditModel } from '@/models/audit.model';
import { DeletionReceiptModel } from '@/models/deletionReceipt.model';
import { TwoFactorModel } from '@/models/twoFactor.model';
import { UserModel, type Role } from '@/models/user.model';
import { withTransaction } from '@/utils/database';
import { newId } from '@/utils/helpers';
import { logger } from '@/utils/logger';
import { allQueues } from '@/utils/queue';

export const RECEIPT_ALGORITHM = 'sha256';

export interface ErasureRecords {
  users: string[];
  user_totp: string[];
  audit_log: number[];
}

export interface ErasureReceipt {
  id: string;
  subjectId: string;
  requestedBy: string;
  timestamp: string;
  algorithm: typeof RECEIPT_ALGORITHM;
  records: ErasureRecords;
  counts: {
    users: number;
    user_totp: number;
    audit_log: number;
    queued_emails_purged: number;
    sales_retained: number;
  };
  digest: string;
}

export interface Actor {
  sub: string;
  role: Role;
}

const placeholderEmail = (userId: string) => `deleted-${userId}@anonymised.invalid`;

/** Sorts object keys at every level, so the same data always serialises the same way. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function digestOf(subjectId: string, timestamp: string, records: ErasureRecords): string {
  return createHash(RECEIPT_ALGORITHM)
    .update(canonicalJson({ subjectId, timestamp, records }))
    .digest('hex');
}

const isEmailTo = (job: unknown, email: string): boolean =>
  typeof job === 'object' &&
  job !== null &&
  typeof (job as { to?: unknown }).to === 'string' &&
  (job as { to: string }).to.toLowerCase() === email;

/** Removes queued emails addressed to `email` from every queue. Returns how many were removed. */
function purgeQueuedEmailsTo(email: string): number {
  const target = email.toLowerCase();
  return allQueues().reduce(
    (total, q) => total + q.purgeWhere((job) => isEmailTo(job, target)),
    0,
  );
}

/**
 * Erases the personal data of `subjectId`. Throws 404 if the user does not exist.
 * Database changes run in one transaction. The queue purge runs inside that
 * transaction too, so a failure before commit leaves the database unchanged.
 */
export function eraseUserData(subjectId: string, actor: Actor): ErasureReceipt {
  const subject = UserModel.findById(subjectId);
  if (!subject) throw notFound('User');

  const timestamp = new Date().toISOString();
  return withTransaction(() => {
    const auditIds = AuditModel.scrubUser(subject.id).sort((a, b) => a - b);
    const totpDeleted = TwoFactorModel.purge(subject.id);
    UserModel.anonymise(subject.id, placeholderEmail(subject.id), randomBytes(32).toString('hex'));
    const salesRetained = UserModel.countSales(subject.id);
    const queuedPurged = purgeQueuedEmailsTo(subject.email);

    const records: ErasureRecords = {
      users: [subject.id],
      user_totp: totpDeleted ? [subject.id] : [],
      audit_log: auditIds,
    };
    const receipt: ErasureReceipt = {
      id: newId(),
      subjectId: subject.id,
      requestedBy: actor.sub,
      timestamp,
      algorithm: RECEIPT_ALGORITHM,
      records,
      counts: {
        users: 1,
        user_totp: records.user_totp.length,
        audit_log: auditIds.length,
        queued_emails_purged: queuedPurged,
        sales_retained: salesRetained,
      },
      digest: digestOf(subject.id, timestamp, records),
    };

    DeletionReceiptModel.create({
      id: receipt.id,
      subjectId: subject.id,
      actorId: actor.sub,
      digest: receipt.digest,
      payload: JSON.stringify(receipt),
      createdAt: timestamp,
    });
    logger.info(`Erased personal data for user ${subject.id} (receipt ${receipt.id})`);
    return receipt;
  });
}

/** True when the receipt's digest matches its own subject, timestamp and record ids. */
export function verifyErasureReceipt(receipt: ErasureReceipt): boolean {
  if (receipt.algorithm !== RECEIPT_ALGORITHM) return false;
  return digestOf(receipt.subjectId, receipt.timestamp, receipt.records) === receipt.digest;
}

/** Returns a stored receipt for a subject. 404 if it does not exist or belongs to someone else. */
export function loadErasureReceipt(subjectId: string, receiptId: string): ErasureReceipt {
  const stored = DeletionReceiptModel.findById(receiptId);
  if (!stored || stored.subjectId !== subjectId) throw notFound('Deletion receipt');
  return JSON.parse(stored.payload) as ErasureReceipt;
}
