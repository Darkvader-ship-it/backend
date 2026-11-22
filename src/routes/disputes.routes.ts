import { Router } from 'express';
import Joi from 'joi';
import { authenticate, authorize } from '@/middleware/auth.middleware';
import { notFound } from '@/middleware/error.middleware';
import { validateBody } from '@/middleware/validate.middleware';
import { DisputeModel, DISPUTE_REASONS, type DisputeStatus } from '@/models/dispute.model';
import { asyncHandler, sendSuccess } from '@/utils/helpers';
import { emit } from '@/services/realtime';

const router = Router();
router.use(authenticate);

const openDisputeSchema = Joi.object({
  transactionId: Joi.string().required(),
  reason: Joi.string().valid(...DISPUTE_REASONS).required(),
  description: Joi.string().trim().min(10).max(1000).required(),
});

const updateStatusSchema = Joi.object({
  status: Joi.string().valid('under_review', 'resolved', 'rejected').required(),
  resolutionNote: Joi.string().trim().max(1000).optional(),
});

const VALID_STATUSES: DisputeStatus[] = ['open', 'under_review', 'resolved', 'rejected'];

/** GET /api/v1/disputes — list all disputes (manager/admin only) */
router.get(
  '/',
  authorize('admin', 'manager'),
  asyncHandler(async (req, res) => {
    const status = VALID_STATUSES.find((s) => s === req.query.status);
    sendSuccess(res, DisputeModel.list(status ? { status } : {}));
  }),
);

/** POST /api/v1/disputes — open a new dispute */
router.post(
  '/',
  validateBody(openDisputeSchema),
  asyncHandler(async (req, res) => {
    const dispute = DisputeModel.open({ ...req.body, openedBy: req.user!.sub });
    emit('transaction:completed', { type: 'dispute:opened', dispute });
    sendSuccess(res, dispute, 201);
  }),
);

/** GET /api/v1/disputes/:id */
router.get(
  '/:id',
  authorize('admin', 'manager'),
  asyncHandler(async (req, res) => {
    const dispute = DisputeModel.findById(req.params.id);
    if (!dispute) throw notFound('Dispute');
    sendSuccess(res, dispute);
  }),
);

/** PATCH /api/v1/disputes/:id — update status (manager/admin) */
router.patch(
  '/:id',
  authorize('admin', 'manager'),
  validateBody(updateStatusSchema),
  asyncHandler(async (req, res) => {
    const dispute = DisputeModel.updateStatus(req.params.id, req.body.status, {
      resolvedBy: req.user!.sub,
      resolutionNote: req.body.resolutionNote,
    });
    emit('transaction:completed', { type: 'dispute:updated', dispute });
    sendSuccess(res, dispute);
  }),
);

/** GET /api/v1/disputes/transaction/:txId — disputes for a specific transaction */
router.get(
  '/transaction/:txId',
  authorize('admin', 'manager'),
  asyncHandler(async (req, res) => {
    sendSuccess(res, DisputeModel.findByTransaction(req.params.txId));
  }),
);

export default router;
