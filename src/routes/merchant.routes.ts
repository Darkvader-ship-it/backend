/**
 * Merchant self-service routes.
 *
 * POST /api/v1/merchant/export
 *   Queues a GDPR Article 20 data-portability export for the signed-in
 *   merchant and returns 202 Accepted immediately. The export is assembled
 *   asynchronously and emailed to the account's registered address (#151).
 */
import { Router } from 'express';
import { authenticate } from '@/middleware/auth.middleware';
import { queueExport } from '@/services/export.service';
import { asyncHandler, sendSuccess } from '@/utils/helpers';
import { UserModel } from '@/models/user.model';
import { AppError } from '@/middleware/error.middleware';

const router = Router();

router.post(
  '/export',
  authenticate,
  asyncHandler(async (req, res) => {
    const userId = req.user!.sub;
    const user = UserModel.findById(userId);
    if (!user) throw new AppError('User not found', 404);

    queueExport({ userId, userEmail: user.email, userName: user.name });

    sendSuccess(
      res,
      { message: 'Export queued. You will receive an email with your data shortly.' },
      202,
    );
  }),
);

export default router;
