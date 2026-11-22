import { getDb, withTransaction } from '@/utils/database';
import { AppError } from '@/middleware/error.middleware';
import { newId } from '@/utils/helpers';

export type DisputeStatus = 'open' | 'under_review' | 'resolved' | 'rejected';
export type DisputeReason = 'incorrect_amount' | 'duplicate_charge' | 'item_not_received' | 'other';

interface DisputeRow {
  id: string;
  transaction_id: string;
  opened_by: string;
  reason: DisputeReason;
  description: string;
  status: DisputeStatus;
  resolution_note: string | null;
  resolved_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface Dispute {
  id: string;
  transactionId: string;
  openedBy: string;
  reason: DisputeReason;
  description: string;
  status: DisputeStatus;
  resolutionNote: string | null;
  resolvedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export const DISPUTE_REASONS: DisputeReason[] = [
  'incorrect_amount',
  'duplicate_charge',
  'item_not_received',
  'other',
];

const toDispute = (r: DisputeRow): Dispute => ({
  id: r.id,
  transactionId: r.transaction_id,
  openedBy: r.opened_by,
  reason: r.reason,
  description: r.description,
  status: r.status,
  resolutionNote: r.resolution_note,
  resolvedBy: r.resolved_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const DisputeModel = {
  open(input: { transactionId: string; openedBy: string; reason: DisputeReason; description: string }): Dispute {
    const id = newId();
    withTransaction((db) => {
      const tx = db.prepare('SELECT id FROM transactions WHERE id = ?').get(input.transactionId);
      if (!tx) throw new AppError('Transaction not found', 404);
      const existing = db
        .prepare("SELECT id FROM disputes WHERE transaction_id = ? AND status NOT IN ('resolved','rejected')")
        .get(input.transactionId);
      if (existing) throw new AppError('An open dispute already exists for this transaction', 409);
      db.prepare(
        `INSERT INTO disputes (id, transaction_id, opened_by, reason, description, status)
         VALUES (?, ?, ?, ?, ?, 'open')`,
      ).run(id, input.transactionId, input.openedBy, input.reason, input.description);
    });
    return this.findById(id)!;
  },

  findById(id: string): Dispute | undefined {
    const row = getDb().prepare('SELECT * FROM disputes WHERE id = ?').get(id) as DisputeRow | undefined;
    return row && toDispute(row);
  },

  findByTransaction(transactionId: string): Dispute[] {
    const rows = getDb()
      .prepare('SELECT * FROM disputes WHERE transaction_id = ? ORDER BY created_at DESC')
      .all(transactionId) as unknown as DisputeRow[];
    return rows.map(toDispute);
  },

  list(filter: { status?: DisputeStatus } = {}): Dispute[] {
    const db = getDb();
    if (filter.status) {
      const rows = db
        .prepare('SELECT * FROM disputes WHERE status = ? ORDER BY created_at DESC')
        .all(filter.status) as unknown as DisputeRow[];
      return rows.map(toDispute);
    }
    const rows = db
      .prepare('SELECT * FROM disputes ORDER BY created_at DESC')
      .all() as unknown as DisputeRow[];
    return rows.map(toDispute);
  },

  updateStatus(
    id: string,
    status: DisputeStatus,
    opts: { resolvedBy?: string; resolutionNote?: string } = {},
  ): Dispute {
    const dispute = getDb().prepare('SELECT * FROM disputes WHERE id = ?').get(id) as DisputeRow | undefined;
    if (!dispute) throw new AppError('Dispute not found', 404);
    if (dispute.status === 'resolved' || dispute.status === 'rejected') {
      throw new AppError(`Dispute is already ${dispute.status}`, 409);
    }
    getDb()
      .prepare(
        `UPDATE disputes SET status = ?, resolved_by = ?, resolution_note = ?,
         updated_at = datetime('now') WHERE id = ?`,
      )
      .run(status, opts.resolvedBy ?? null, opts.resolutionNote ?? null, id);
    return this.findById(id)!;
  },
};
