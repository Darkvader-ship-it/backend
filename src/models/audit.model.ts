import { getDb } from '@/utils/database';

const HAS_PERSONAL_DATA = '(user_email IS NOT NULL OR ip IS NOT NULL)';

export const AuditModel = {
  /**
   * Clears the email address and IP recorded against a user's audit rows. The
   * rows stay, with their action, path, status and time, so the trail keeps its
   * shape. Returns the ids of the rows that were changed.
   */
  scrubUser(userId: string): number[] {
    const db = getDb();
    const rows = db
      .prepare(`SELECT id FROM audit_log WHERE user_id = ? AND ${HAS_PERSONAL_DATA} ORDER BY id`)
      .all(userId) as unknown as { id: number }[];
    if (rows.length) {
      db.prepare(
        `UPDATE audit_log SET user_email = NULL, ip = NULL WHERE user_id = ? AND ${HAS_PERSONAL_DATA}`,
      ).run(userId);
    }
    return rows.map((r) => r.id);
  },
};
