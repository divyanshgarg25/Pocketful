import { approvalsRepo } from '../repos/approvals.js';
import { groupsRepo } from '../repos/groups.js';
import { ConflictError } from '../core/errors.js';
import type { Profile } from '../schemas/domain.js';

/**
 * Currency can only change when nothing denominated in the old currency is in flight:
 * no open approvals, no pending group outings, and nothing executed this week (the weekly
 * cap window would otherwise mix two currencies).
 */
export async function assertCurrencyChangeAllowed(user: Profile): Promise<void> {
  const open = (await approvalsRepo.listOpenForReconcile()).filter(
    (a) => a.user_id === user.id && a.action_type !== 'change_currency'
  );
  if (open.length > 0) {
    throw new ConflictError('Finish or cancel your open approvals before changing currency.');
  }
  const groups = (await groupsRepo.getGroupsByOrganizer(user.id)).filter((g) => g.status === 'pending');
  if (groups.length > 0) {
    throw new ConflictError('You have open group outings. Finish or cancel them before changing currency.');
  }
  if ((await approvalsRepo.getExecutedThisWeekTotal(user.id, user.timezone)) > 0) {
    throw new ConflictError('Currency can only be changed before spending anything this week.');
  }
}
