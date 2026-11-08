import { Router } from 'express';
import { profilesRepo } from '../repos/profiles.js';
import { subscriptionsRepo } from '../repos/subscriptions.js';
import { transactionsRepo } from '../repos/transactions.js';
import { vaultRepo } from '../repos/vault.js';
import { moneyService } from '../services/money.js';
import { sendSuccess, handleRouteError, NotFoundError } from '../core/errors.js';
import type { AuthenticatedRequest } from '../core/auth.js';

export const walletRouter = Router();

walletRouter.get('/api/wallet', async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const user = await profilesRepo.getById(authReq.userId);
    if (!user) throw new NotFoundError('User not found.');

    const subs = await subscriptionsRepo.getByUserId(authReq.userId);
    const activeSubs = subs.filter((s) => s.status === 'active');

    // Total monthly subscription expenditure
    let subsMinor = 0;
    for (const s of activeSubs) {
      subsMinor += moneyService.normalizeToMonthlyMinor(s.amount_minor, s.interval);
    }

    // Query real essential transactions for fixed bills
    const txns = await transactionsRepo.getByUserId(authReq.userId);
    const fixedBillsMinor = txns
      .filter((t) => t.kind === 'essential' && !t.excluded)
      .reduce((sum, t) => sum + t.amount_minor, 0);

    const pockets = await vaultRepo.getPockets(authReq.userId);
    const weeklyPocket = pockets.find((p) => p.kind === 'weekly');
    const holidayPocket = pockets.find((p) => p.kind === 'holiday');
    const getawayPocket = pockets.find((p) => p.kind === 'getaway');

    const vault = await vaultRepo.getVault(authReq.userId);
    const savingsGoalMinor = vault?.goal_balance_minor ?? 0;
    const rolloverBalanceMinor = vault?.rollover_balance_minor ?? 0;

    const pocketsSum = pockets.reduce((sum, p) => sum + p.balance_minor, 0);
    const totalBalanceMinor = pocketsSum + rolloverBalanceMinor + savingsGoalMinor;

    const freeForWeekendMinor = weeklyPocket
      ? weeklyPocket.balance_minor
      : moneyService.computeFunMoney(
          totalBalanceMinor,
          fixedBillsMinor,
          subsMinor,
          savingsGoalMinor,
          user.guilt_free_cap_minor
        );

    const data = {
      statement: {
        totalBalanceMinor,
        totalBalanceFormatted: moneyService.format(totalBalanceMinor, user.currency),
        totalBalanceSource: 'ledger',

        fixedBillsMinor,
        fixedBillsFormatted: moneyService.format(fixedBillsMinor, user.currency),
        fixedBillsSource: 'transactions',

        subscriptionsMinor: subsMinor,
        subscriptionsFormatted: moneyService.format(subsMinor, user.currency),
        subscriptionsSource: 'subscriptions',

        savingsGoalMinor,
        savingsGoalFormatted: moneyService.format(savingsGoalMinor, user.currency),
        savingsGoalSource: 'vault',

        freeForWeekendMinor,
        freeForWeekendFormatted: moneyService.format(freeForWeekendMinor, user.currency),
        guiltFreeCapMinor: user.guilt_free_cap_minor,
        currency: user.currency
      },
      pockets: {
        weekly: weeklyPocket?.balance_minor ?? freeForWeekendMinor,
        holiday: holidayPocket?.balance_minor ?? 0,
        getaway: getawayPocket?.balance_minor ?? 0
      },
      vault: {
        goalBalanceMinor: savingsGoalMinor,
        goalBalanceFormatted: moneyService.format(savingsGoalMinor, user.currency),
        rolloverBalanceMinor: rolloverBalanceMinor,
        rolloverBalanceFormatted: moneyService.format(rolloverBalanceMinor, user.currency),
        isSimulated: vault?.is_simulated ?? false
      }
    };

    sendSuccess(res, data, authReq.requestId);
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});
