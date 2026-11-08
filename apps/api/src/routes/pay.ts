import { Router } from 'express';
import { groupsRepo } from '../repos/groups.js';
import { profilesRepo } from '../repos/profiles.js';
import { suggestionsRepo } from '../repos/suggestions.js';
import { venuesRepo } from '../repos/venues.js';
import { settlePayment, refundLateCapture } from '../services/settlement.js';
import { moneyService } from '../services/money.js';
import { paypalService } from '../services/paypal.js';
import { sendSuccess, sendError, handleRouteError } from '../core/errors.js';

export const payRouter = Router();

// Public Friend Page Data (unauthenticated)
payRouter.get('/pay/:token', async (req, res) => {
  try {
    const token = req.params['token'] as string;
    const payment = await groupsRepo.getPaymentByToken(token);
    if (!payment) {
      sendError(res, 'NOT_FOUND', 'Payment invite link not found or expired.', 404);
      return;
    }

    const group = await groupsRepo.getGroupById(payment.group_id);
    if (!group) {
      sendError(res, 'NOT_FOUND', 'Group outing not found.', 404);
      return;
    }

    // Mark payment viewed on first GET
    await groupsRepo.markPaymentViewed(payment.id);

    const organizer = await profilesRepo.getById(group.organizer_id);
    const organizerFirstName = organizer?.name.split(' ')[0] ?? 'A friend';

    let venueName = 'Weekend Outing';
    if (group.suggestion_id) {
      const suggestion = await suggestionsRepo.getById(group.suggestion_id);
      if (suggestion) {
        const venue = await venuesRepo.getById(suggestion.venue_id);
        if (venue) venueName = venue.name;
      }
    }

    // List other friends who have already paid (first names only, privacy preserved)
    const allPayments = await groupsRepo.getPaymentsByGroupId(group.id);
    const paidFriends = allPayments
      .filter((p) => p.status === 'paid' && p.id !== payment.id)
      .map((p) => p.friend_name.split(' ')[0] ?? 'Friend');

    sendSuccess(res, {
      friendName: payment.friend_name,
      organizerName: organizerFirstName,
      venueName,
      shareMinor: payment.share_minor,
      shareFormatted: moneyService.format(payment.share_minor, group.currency),
      currency: group.currency,
      deadline: group.deadline,
      status: payment.status,
      groupStatus: group.status,
      payUrl: payment.pay_url,
      paidFriends,
      isGroupConfirmed: group.status === 'confirmed'
    });
  } catch (err) {
    handleRouteError(res, err);
  }
});

// Capture Friend Payment (PayPal Sandbox Checkout return)
payRouter.post('/pay/:token/capture', async (req, res) => {
  try {
    const token = req.params['token'] as string;
    const payment = await groupsRepo.getPaymentByToken(token);
    if (!payment) {
      sendError(res, 'NOT_FOUND', 'Payment invite not found.', 404);
      return;
    }

    const group = await groupsRepo.getGroupById(payment.group_id);
    if (!group) {
      sendError(res, 'NOT_FOUND', 'Group not found.', 404);
      return;
    }

    // Protection 1: If already paid, return idempotent success
    if (payment.status === 'paid') {
      sendSuccess(res, {
        payment,
        groupConfirmed: group.status === 'confirmed',
        message: 'Payment already received! Your share is confirmed.',
        replayed: true
      });
      return;
    }

    // Protection 2: Check if payment or group has been refunded or cancelled
    if (payment.status === 'refunded' || group.status === 'refunded') {
      sendError(res, 'ALREADY_REFUNDED', 'This outing was cancelled and payment has been refunded.', 400);
      return;
    }
    if (group.status === 'cancelled' || payment.status === 'cancelled') {
      sendError(res, 'OUTING_CANCELLED', 'This group outing has been cancelled. No payment is required.', 410);
      return;
    }

    // Protection 3: Require payment.status === 'sent' or 'viewed'
    if (payment.status === 'draft') {
      sendError(res, 'CONFLICT', 'Payment request is still in draft and has not been sent by the organizer yet.', 409);
      return;
    }
    if (payment.status !== 'sent' && payment.status !== 'viewed') {
      sendError(res, 'CONFLICT', `Payment cannot be captured because status is "${payment.status}".`, 409);
      return;
    }

    // Protection 4: Require group.status === 'pending'
    if (group.status !== 'pending') {
      sendError(res, 'CONFLICT', `Outing is not pending payment (status: "${group.status}").`, 409);
      return;
    }

    // Protection 5: Token / Deadline Expiry Check
    if (new Date(group.deadline).getTime() < Date.now()) {
      sendError(res, 'OUTING_EXPIRED', 'The payment deadline for this outing has passed.', 410);
      return;
    }

    // Protection 6: paypal_ref must exist (never default to ORD-DEMO)
    if (!payment.paypal_ref) {
      sendError(res, 'CONFLICT', 'PayPal order reference missing for this payment.', 409);
      return;
    }

    // Claim the capture atomically so two requests can never both call PayPal for this order.
    const claimed = await groupsRepo.beginCapture(payment.id);
    if (!claimed) {
      const fresh = await groupsRepo.getPaymentById(payment.id);
      if (fresh?.status === 'paid') {
        sendSuccess(res, { payment: fresh, groupConfirmed: (await groupsRepo.getGroupById(group.id))?.status === 'confirmed', message: 'Payment already received! Your share is confirmed.', replayed: true });
        return;
      }
      sendError(res, 'CONFLICT', 'A payment attempt for this share is already in progress.', 409);
      return;
    }

    let captureResult;
    try {
      captureResult = await paypalService.captureOrder(payment.paypal_ref);
    } catch (err) {
      await groupsRepo.releaseCapture(payment.id);
      throw err;
    }
    if (captureResult.status !== 'COMPLETED') {
      await groupsRepo.releaseCapture(payment.id);
      sendError(res, 'CONFLICT', `PayPal capture was not completed (status: ${captureResult.status}).`, 409);
      return;
    }

    const settled = await settlePayment({
      groupId: group.id,
      paymentId: payment.id,
      captureId: captureResult.captureId,
      amountValue: captureResult.amount,
      currency: captureResult.currency,
      payeeMerchantId: captureResult.payeeMerchantId,
      source: 'capture_route'
    });

    switch (settled.outcome) {
      case 'settled':
        sendSuccess(res, {
          payment: settled.payment,
          groupConfirmed: settled.groupConfirmed,
          message: 'Payment received! Your share is confirmed.'
        });
        return;
      case 'already_paid':
        sendSuccess(res, { payment: settled.payment, groupConfirmed: (await groupsRepo.getGroupById(group.id))?.status === 'confirmed', message: 'Payment already received! Your share is confirmed.', replayed: true });
        return;
      case 'late_capture_refunded':
        sendError(res, 'OUTING_CANCELLED', 'This outing is no longer open. Your payment was refunded automatically.', 410);
        return;
      case 'late_capture_refund_failed':
        sendError(res, 'UPSTREAM_PAYPAL', 'This outing is no longer open and the automatic refund is pending. You will not be charged.', 502);
        return;
      case 'rejected':
        // Money was captured but did not match what we expected: never credit it; refund + alert.
        await refundLateCapture(payment.id, captureResult.captureId, 'capture_route_rejected');
        sendError(res, 'VALIDATION_FAILED', 'Captured amount did not match your share and was refunded.', 400);
        return;
    }
  } catch (err) {
    handleRouteError(res, err);
  }
});
