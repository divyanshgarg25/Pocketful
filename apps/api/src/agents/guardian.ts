import { approvalsRepo } from '../repos/approvals.js';
import { auditRepo } from '../repos/audit.js';
import { groupsRepo } from '../repos/groups.js';
import { eventBus } from '../core/events.js';
import {
  AppError,
  ConflictError,
  ApprovalExpiredError,
  ForbiddenError,
  GuardianBlockedError,
  NotFoundError
} from '../core/errors.js';
import type { Profile, Approval, ApprovalActionType } from '../schemas/domain.js';
import crypto from 'crypto';

export type GuardianEvaluation =
  | { kind: 'allow' }
  | { kind: 'needs_approval'; preview: string; amountMinor: number; moneyOutMinor: number }
  | { kind: 'block'; reason: string };

export interface ActionRequest {
  type: ApprovalActionType;
  amountMinor: number;
  moneyOutMinor?: number;
  payload: Record<string, unknown>;
  preview: string;
  idempotencyKey?: string;
}

export function computeMoneyOutMinor(
  actionType: ApprovalActionType,
  amountMinor: number,
  _payload?: Record<string, unknown>
): number {
  switch (actionType) {
    case 'cancel_subscription':
    case 'reset_learning':
    case 'delete_data':
    case 'change_caps':
    case 'change_currency':
    case 'send_requests':
    case 'refund_group':
      return 0; // No money leaves user (returning money is not money leaving user)
    case 'vault_move':
    case 'pocket_move':
      return amountMinor;
    default:
      return amountMinor;
  }
}

export class GuardianAgent {
  readonly name = 'guardian';

  /**
   * Evaluate a requested action against deterministic financial safety policies.
   * Zero LLM involvement.
   */
  async evaluate(user: Profile, action: ActionRequest): Promise<GuardianEvaluation> {
    const moneyOut = action.moneyOutMinor ?? computeMoneyOutMinor(action.type, action.amountMinor, action.payload);

    // 0. Cap value 0 means spending is completely BLOCKED (never unlimited)
    if (
      (moneyOut > 0 || (action.type === 'refund_group' && action.amountMinor > 0)) &&
      (user.per_action_cap_minor === 0 || user.weekly_cap_minor === 0)
    ) {
      const reason = 'Spending safety cap is set to $0.00 (spending is locked).';
      return { kind: 'block', reason };
    }

    // 1. Per-Action Cap Check
    // Actions where no money leaves user or returning money are exempt
    let checkAmountMinor = action.amountMinor;
    if (action.type === 'send_requests') {
      let orgShare: number | undefined =
        typeof action.payload?.organizerShareMinor === 'number'
          ? (action.payload.organizerShareMinor as number)
          : typeof action.payload?.organizerShare === 'number'
            ? (action.payload.organizerShare as number)
            : undefined;

      if (orgShare === undefined && typeof action.payload?.groupId === 'string') {
        const group = await groupsRepo.getGroupById(action.payload.groupId as string);
        if (group) {
          const pmts = await groupsRepo.getPaymentsByGroupId(group.id);
          const friendTotal = pmts.reduce((sum, p) => sum + p.share_minor, 0);
          orgShare = Math.max(0, group.total_minor - friendTotal);
        }
      }
      checkAmountMinor = orgShare ?? action.amountMinor;
    }

    if (
      action.type !== 'cancel_subscription' &&
      action.type !== 'refund_group' &&
      action.type !== 'reset_learning' &&
      action.type !== 'delete_data' &&
      action.type !== 'change_caps' &&
      action.type !== 'change_currency' &&
      user.per_action_cap_minor > 0 &&
      checkAmountMinor > user.per_action_cap_minor
    ) {
      const reason = `Action amount ($${(checkAmountMinor / 100).toFixed(2)}) exceeds your per-action safety cap of $${(
        user.per_action_cap_minor / 100
      ).toFixed(2)}.`;
      return { kind: 'block', reason };
    }

    // 2. Weekly Cap Check (checks money leaving the user within the user timezone weekly window)
    const executedThisWeek = await approvalsRepo.getExecutedThisWeekTotal(user.id, user.timezone);
    if (
      moneyOut > 0 &&
      user.weekly_cap_minor > 0 &&
      executedThisWeek + moneyOut > user.weekly_cap_minor
    ) {
      const reason = `This action would bring your weekly money out to $${(
        (executedThisWeek + moneyOut) /
        100
      ).toFixed(2)}, which exceeds your weekly safety cap of $${(user.weekly_cap_minor / 100).toFixed(2)}.`;
      return { kind: 'block', reason };
    }

    // 3. Money & Destructive Actions always require explicit user approval
    const requiresApprovalSet: Set<ApprovalActionType> = new Set([
      'cancel_subscription',
      'send_requests',
      'refund_group',
      'vault_move',
      'pocket_move',
      'reset_learning',
      'delete_data',
      'change_caps',
      'change_currency'
    ]);

    if (requiresApprovalSet.has(action.type)) {
      return {
        kind: 'needs_approval',
        preview: action.preview,
        amountMinor: action.amountMinor,
        moneyOutMinor: moneyOut
      };
    }

    return { kind: 'allow' };
  }

  /**
   * Create an unexpired Approval record (10-minute validity)
   */
  async requestApproval(
    user: Profile,
    action: ActionRequest,
    requestId?: string
  ): Promise<{ approval: Approval | null; blockedReason?: string }> {
    const evaluation = await this.evaluate(user, action);

    if (evaluation.kind === 'block') {
      await auditRepo.log({
        user_id: user.id,
        request_id: requestId,
        agent: this.name,
        action: `blocked_${action.type}`,
        params: { action, reason: evaluation.reason },
        result: { status: 'blocked', reason: evaluation.reason }
      });
      return { approval: null, blockedReason: evaluation.reason };
    }

    const idempotencyKey = action.idempotencyKey || crypto.randomUUID();

    // Check if an existing approval exists with this key
    const existing = await approvalsRepo.getByIdempotencyKey(user.id, idempotencyKey);
    const isDead =
      existing &&
      (existing.status === 'denied' ||
        existing.status === 'expired' ||
        existing.status === 'failed' ||
        existing.status === 'cancelled' ||
        new Date(existing.expires_at) < new Date());

    if (existing && !isDead) {
      return { approval: existing };
    }

    // If dead or not found, generate a fresh active key
    const finalKey = isDead ? `${idempotencyKey}_${Date.now()}` : idempotencyKey;
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes expiry
    const moneyOut = action.moneyOutMinor ?? computeMoneyOutMinor(action.type, action.amountMinor, action.payload);

    const approval = await approvalsRepo.create({
      id: crypto.randomUUID(),
      user_id: user.id,
      action_type: action.type,
      payload: action.payload,
      preview: action.preview,
      amount_minor: action.amountMinor,
      money_out_minor: moneyOut,
      status: 'pending',
      idempotency_key: finalKey,
      retry_count: 0,
      result: null,
      expires_at: expiresAt
    });

    await auditRepo.log({
      user_id: user.id,
      request_id: requestId,
      agent: this.name,
      action: `approval_staged_${action.type}`,
      params: { action_type: action.type, amount_minor: action.amountMinor, money_out_minor: moneyOut, preview: action.preview },
      approval_id: approval.id,
      result: { approval_id: approval.id, status: 'pending' }
    });

    return { approval };
  }

  /**
   * Re-validate approval at execution time (assert unexpired, correct status, within caps)
   */
  assertExecutable(approval: Approval, user: Profile): void {
    if (approval.status !== 'approved' && approval.status !== 'executing') {
      throw new ConflictError(`Approval cannot be executed because status is "${approval.status}".`);
    }

    const now = new Date();
    if (new Date(approval.expires_at) < now) {
      throw new ApprovalExpiredError('This approval request has expired (10-minute window passed). Please review and approve again.');
    }

    if (approval.user_id !== user.id) {
      throw new ForbiddenError('Security check failed: Approval does not belong to the authenticated user.');
    }

    const moneyOut = approval.money_out_minor ?? 0;
    if (moneyOut > 0 && user.per_action_cap_minor > 0 && moneyOut > user.per_action_cap_minor) {
      throw new GuardianBlockedError('Action blocked at execution time: Amount exceeds per-action safety cap.');
    }
  }

  /**
   * Finalize and execute an approved action with fail-closed audit intent logging
   */
  async executeApprovedAction<T>(
    approvalId: string,
    user: Profile,
    executor: (payload: Record<string, unknown>) => Promise<T>,
    requestId?: string
  ): Promise<{ approval: Approval; result: T }> {
    const approval = await approvalsRepo.getById(approvalId, user.id);
    if (!approval) throw new NotFoundError('Approval record not found.');

    this.assertExecutable(approval, user);

    // Fail-closed: Write audit intent before executing
    await auditRepo.log({
      user_id: user.id,
      request_id: requestId,
      agent: this.name,
      action: `execution_intent_${approval.action_type}`,
      params: { payload: approval.payload },
      approval_id: approval.id,
      result: { status: 'executing' }
    });

    let sideEffectDone = false;
    try {
      // Execute the underlying financial / business operation
      const result = await executor(approval.payload);
      sideEffectDone = true;

      // Persist the outcome BEFORE the status flip: once the side effect happened this approval
      // must never become `failed` (a retry would run the side effect a second time).
      await approvalsRepo.updateStatus(
        approval.id,
        'executing',
        undefined,
        user.id,
        { execution_outcome: (result && typeof result === 'object' ? result : { value: result }) as Record<string, unknown> },
        ['executing']
      );
      const updated = await approvalsRepo.updateStatus(approval.id, 'executed', result as Record<string, unknown>, user.id, undefined, ['executing']);
      if (!updated) throw new ConflictError('Failed to update approval execution status.');

      await auditRepo.log({
        user_id: user.id,
        request_id: requestId,
        agent: this.name,
        action: `executed_${approval.action_type}`,
        params: { payload: approval.payload },
        approval_id: approval.id,
        result: result as Record<string, unknown>
      });

      eventBus.emitEvent('approval.executed', { approval: updated, result });

      return { approval: updated, result };
    } catch (err) {
      if (!sideEffectDone) {
        await approvalsRepo.updateStatus(approval.id, 'failed', { error: err instanceof AppError ? err.code : 'EXECUTION_FAILED' }, user.id, undefined, ['executing']);
        await auditRepo.log({
          user_id: user.id,
          request_id: requestId,
          agent: this.name,
          action: `execution_failed_${approval.action_type}`,
          approval_id: approval.id,
          result: { error: err instanceof AppError ? err.code : 'EXECUTION_FAILED' }
        });
      } else {
        await auditRepo.log({
          user_id: user.id,
          request_id: requestId,
          agent: this.name,
          action: `execution_bookkeeping_failed_${approval.action_type}`,
          approval_id: approval.id,
          result: { note: 'side effect completed; status left in executing for reconciliation' }
        });
      }
      throw err;
    }
  }
}

export const guardianAgent = new GuardianAgent();
