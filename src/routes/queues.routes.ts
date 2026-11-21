import { Router } from 'express';
import { authenticate, authorize } from '@/middleware/auth.middleware';
import { badRequest, notFound } from '@/middleware/error.middleware';
import { asyncHandler, sendSuccess } from '@/utils/helpers';
import { listDeadLetters, QUEUE_NAMES, requeueDeadLetter, type QueueName } from '@/utils/queue';

const router = Router();
router.use(authenticate, authorize('admin'));

/** GET /dead-letters?queue=receipts - failed jobs with payload, error and stack. Admin only. */
router.get(
  '/dead-letters',
  asyncHandler(async (req, res) => {
    const raw = req.query.queue;
    let queue: QueueName | undefined;
    if (raw !== undefined) {
      if (typeof raw !== 'string' || !(QUEUE_NAMES as readonly string[]).includes(raw)) {
        throw badRequest(`queue must be one of: ${QUEUE_NAMES.join(', ')}`);
      }
      queue = raw as QueueName;
    }
    sendSuccess(res, listDeadLetters(queue));
  }),
);

/** POST /dead-letters/:id/requeue - puts the job back on its queue. Admin only. */
router.post(
  '/dead-letters/:id/requeue',
  asyncHandler(async (req, res) => {
    if (!requeueDeadLetter(req.params.id)) throw notFound('Dead-letter job');
    sendSuccess(res, { id: req.params.id, requeued: true });
  }),
);

export default router;
