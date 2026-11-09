import { describe, it, expect, beforeEach } from 'vitest';
import { learnerAgent } from '../src/agents/learner.js';
import { banditRepo } from '../src/repos/bandit.js';
import { localDb } from '../src/core/database.js';

describe('Learner Agent - Hardened Thompson Sampling (H12)', () => {
  const userId = '00000000-0000-4000-8000-000000000001';

  beforeEach(() => {
    localDb.bandit_state.clear();
    localDb.learning_events = [];
  });

  it('organic_too_much feedback penalizes price_band without penalizing category', async () => {
    const features = {
      category: 'cafes',
      price_band: 'high'
    };

    // Apply "too much" rating
    await learnerAgent.applyEvent(userId, features, 'organic_too_much');

    const stateMap = await banditRepo.getBanditStateForUser(userId);
    const catState = stateMap.get('category:cafes');
    const priceState = stateMap.get('price_band:high');

    expect(catState).toBeDefined();
    expect(priceState).toBeDefined();

    // Category beta should NOT have been penalized (beta remains 1)
    expect(catState!.beta).toBe(1);
    // Category alpha is mildly positive or neutral (alpha >= 1)
    expect(catState!.alpha).toBeGreaterThanOrEqual(1);

    // Price band beta MUST have been penalized by +1.0
    expect(priceState!.beta).toBe(2); // 1 + 1.0 = 2
    expect(priceState!.alpha).toBe(1); // alpha remains untouched
  });

  it('revertEvent rolls back bandit state accurately when a rating is updated', async () => {
    const features = {
      category: 'gaming',
      price_band: 'mid'
    };

    // 1. Initial event: organic_worth_it (adds +1.5 to alpha)
    await learnerAgent.applyEvent(userId, features, 'organic_worth_it');
    let stateMap = await banditRepo.getBanditStateForUser(userId);
    expect(stateMap.get('category:gaming')!.alpha).toBe(2.5); // 1 + 1.5

    // 2. Revert the organic_worth_it event
    await learnerAgent.revertEvent(userId, features, 'organic_worth_it');
    stateMap = await banditRepo.getBanditStateForUser(userId);
    expect(stateMap.get('category:gaming')!.alpha).toBe(1); // restored to baseline 1

    // 3. Verify revert event was logged with reverted: true
    const events = await banditRepo.getEventsForUser(userId, true);
    expect(events.some((e) => e.event_type === 'revert_organic_worth_it' && e.reverted)).toBe(true);
  });

  it('caps alpha and beta at 200 to prevent permanent state saturation', async () => {
    const features = { category: 'sports' };

    // Apply repeated positive events
    for (let i = 0; i < 250; i++) {
      await learnerAgent.applyEvent(userId, features, 'organic_worth_it');
    }

    const stateMap = await banditRepo.getBanditStateForUser(userId);
    const sportsState = stateMap.get('category:sports');
    expect(sportsState!.alpha).toBeLessThanOrEqual(200);

    // Apply repeated rejections
    for (let i = 0; i < 250; i++) {
      await learnerAgent.applyRejection(userId, features, 'not_my_vibe');
    }

    const updatedState = (await banditRepo.getBanditStateForUser(userId)).get('category:sports');
    expect(updatedState!.beta).toBeLessThanOrEqual(200);
  });

  it('nightly decay moves evidence (alpha and beta) towards the neutral prior of 1', async () => {
    const features = { category: 'outdoors' };
    await learnerAgent.applyEvent(userId, features, 'organic_worth_it'); // alpha = 2.5

    const state = (await banditRepo.getBanditStateForUser(userId)).get('category:outdoors')!;
    const initialAlpha = state.alpha;
    expect(initialAlpha).toBeGreaterThan(1);

    // Run decay
    await learnerAgent.decay(userId);

    const decayedState = (await banditRepo.getBanditStateForUser(userId)).get('category:outdoors')!;
    expect(decayedState.alpha).toBeLessThan(initialAlpha);
    expect(decayedState.alpha).toBeGreaterThanOrEqual(1);
  });
});
