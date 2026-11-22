import type { Request, Response } from 'express';
import { eraseUserData, loadErasureReceipt } from '@/services/gdpr.service';
import { sendSuccess } from '@/utils/helpers';

/** DELETE /users/:id/data. The route guard limits this to the subject or an admin. */
export async function eraseUser(req: Request, res: Response): Promise<void> {
  sendSuccess(res, eraseUserData(req.params.id, req.user!));
}

/** GET /users/:id/data/receipts/:receiptId. Returns the receipt issued at erasure. */
export async function getErasureReceipt(req: Request, res: Response): Promise<void> {
  sendSuccess(res, loadErasureReceipt(req.params.id, req.params.receiptId));
}
