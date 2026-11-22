import { getDb } from '@/utils/database';

export interface StoredDeletionReceipt {
  id: string;
  subjectId: string;
  actorId: string;
  digest: string;
  /** The full receipt as issued, JSON. Holds record ids and counts only, never personal data. */
  payload: string;
  createdAt: string;
}

interface Row {
  id: string;
  subject_id: string;
  actor_id: string;
  digest: string;
  payload: string;
  created_at: string;
}

const toReceipt = (r: Row): StoredDeletionReceipt => ({
  id: r.id,
  subjectId: r.subject_id,
  actorId: r.actor_id,
  digest: r.digest,
  payload: r.payload,
  createdAt: r.created_at,
});

export const DeletionReceiptModel = {
  create(input: Omit<StoredDeletionReceipt, 'createdAt'> & { createdAt: string }): void {
    getDb()
      .prepare(
        `INSERT INTO deletion_receipts (id, subject_id, actor_id, digest, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.subjectId, input.actorId, input.digest, input.payload, input.createdAt);
  },

  findById(id: string): StoredDeletionReceipt | undefined {
    const row = getDb().prepare('SELECT * FROM deletion_receipts WHERE id = ?').get(id) as
      | Row
      | undefined;
    return row && toReceipt(row);
  },
};
