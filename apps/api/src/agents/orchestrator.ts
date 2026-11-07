import { profilesRepo } from '../repos/profiles.js';
import { vaultRepo } from '../repos/vault.js';
import { auditorAgent } from './auditor.js';
import { plannerAgent } from './planner.js';
import { learnerAgent } from './learner.js';
import { chatRepo } from '../repos/chat.js';
import { auditRepo } from '../repos/audit.js';
import { moneyService } from '../services/money.js';
import { NotFoundError } from '../core/errors.js';
import type { ChatMessage, Approval } from '../schemas/domain.js';
import crypto from 'crypto';

export interface ChatResponse {
  reply: string;
  cards?: Array<Record<string, unknown>>;
  pendingApprovals?: Approval[];
}

export class OrchestratorAgent {
  readonly name = 'orchestrator';
  readonly maxSteps = 6;

  /**
   * Main conversational interface with Pip
   */
  async processUserMessage(
    userId: string,
    messageText: string,
    requestId?: string
  ): Promise<ChatResponse> {
    const user = await profilesRepo.getById(userId);
    if (!user) throw new NotFoundError('User profile not found.');

    // Save incoming user message
    await chatRepo.append({
      id: crypto.randomUUID(),
      user_id: userId,
      role: 'user',
      content: messageText,
      proactive: false,
      read: true,
      created_at: new Date().toISOString()
    });

    const pendingApprovals: Approval[] = [];
    let reply = '';
    const cards: Array<Record<string, unknown>> = [];

    // Safe Natural Language Routing with Word Boundaries to Deterministic Agent Tools
    if (/\b(audit|subscriptions?|recurring|waste|ghosts?)\b/i.test(messageText)) {
      const audit = await auditorAgent.runAudit(userId);
      reply = `I reviewed your subscriptions. You have ${audit.ghostSubscriptions.length} subscriptions that look unused, quietly draining ${audit.totalYearlyWasteFormatted} a year. Would you like to review and cancel them?`;
      cards.push({
        type: 'audit_summary',
        yearlyWaste: audit.totalYearlyWasteFormatted,
        ghosts: audit.ghostSubscriptions.map((g) => ({
          id: g.id,
          merchant: g.merchant,
          amount: moneyService.format(g.amount_minor),
          reason: g.explanation
        }))
      });
    } else if (/\b(plans?|planning|weekends?|quiet|tickets?|spots?|ideas?)\b/i.test(messageText)) {
      const mood = /\b(tired|drained|rough|exhausted)\b/i.test(messageText)
        ? 'drained'
        : /\b(great|excited|energetic|amazing)\b/i.test(messageText)
        ? 'great'
        : 'okay';

      const plan = await plannerAgent.generatePlan(userId, { mood, requestId });
      reply = `I put together a 3-slot plan for you with ${plan.budgetFormatted} free. Calm options lead your tickets.`;
      cards.push({
        type: 'plan_tickets',
        planId: plan.planId,
        slots: plan.slots.map((s) => ({
          slot: s.slot,
          suggestionId: s.suggestionId,
          name: s.venue.name,
          category: s.venue.category,
          distKm: s.distKm,
          costRange: `${moneyService.format(s.costLowMinor)}–${moneyService.format(s.costHighMinor)}`,
          headline: s.headline,
          why: s.why
        }))
      });
    } else if (/\b(splits?|bill\s+split|splitting)\b/i.test(messageText)) {
      reply = `To split an outing with friends, head over to the Split tab or click 'Split with friends' directly on any plan ticket. You can choose equal or custom amounts and enter friends' emails or phone numbers to send secure PayPal payment requests.`;
    } else if (/\b(learn|learned|tastes?|preferences?|know\s+about\s+me)\b/i.test(messageText)) {
      const lines = await learnerAgent.getLearnedLines(userId);
      const linesText = lines.map((l) => `• ${l.text}`).join('\n');
      reply = `Here is what your ledger choices have taught me:\n${linesText}`;
      cards.push({
        type: 'learned_profile',
        lines
      });
    } else if (/\b(wallet|balance|cash|fun\s+money|pockets?|discretionary)\b/i.test(messageText)) {
      const pocket = await vaultRepo.getPocket(userId, 'weekly');
      const user = await profilesRepo.getById(userId);
      const free = pocket?.balance_minor ?? user?.guilt_free_cap_minor ?? 0;
      reply = `You have ${moneyService.format(free, user?.currency)} in available fun money for this weekend after bills and savings.`;
    } else if (/\b(vault|sunday\s+vault|rollover|lock\s*in)\b/i.test(messageText)) {
      const vault = await vaultRepo.getVault(userId);
      const goal = vault ? moneyService.format(vault.goal_balance_minor) : '$0.00';
      reply = `Your Sunday Vault currently has ${goal} safely tucked away toward your savings goal.`;
    } else {
      reply = `Hello! I am Pip. I can audit forgotten subscriptions, plan a calm weekend within your reach, or help you track your leisure spending. What sounds best right now?`;
    }

    // Save Pip's response
    const botMsg: ChatMessage = {
      id: crypto.randomUUID(),
      user_id: userId,
      role: 'pip',
      content: reply,
      cards: cards.length > 0 ? cards : null,
      proactive: false,
      read: true,
      created_at: new Date().toISOString()
    };
    await chatRepo.append(botMsg);

    await auditRepo.log({
      user_id: userId,
      request_id: requestId,
      agent: this.name,
      action: 'pip_replied',
      params: { messageLength: messageText.length },
      result: { replyPreview: reply.slice(0, 100) }
    });

    return {
      reply,
      cards,
      pendingApprovals
    };
  }

  /**
   * Post proactive Friday note or Sunday vault prompt
   */
  async postProactiveNote(
    userId: string,
    type: 'friday_brief' | 'sunday_vault',
    requestId?: string
  ): Promise<ChatMessage> {
    let content = '';
    const cards: Array<Record<string, unknown>> = [];

    if (type === 'friday_brief') {
      const pocket = await vaultRepo.getPocket(userId, 'weekly');
      const user = await profilesRepo.getById(userId);
      const free = moneyService.format(pocket?.balance_minor ?? user?.guilt_free_cap_minor ?? 0, user?.currency);
      content = `Friday afternoon. You have ${free} free for the weekend after bills and savings. Three ideas are ready whenever you want to see them.`;
    } else {
      content = `Sunday evening. The weekend is winding down. Would you like to lock your leftover fun money into your savings goal or roll it over to a mega-weekend?`;
    }

    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      user_id: userId,
      role: 'pip',
      content,
      cards: cards.length > 0 ? cards : null,
      proactive: true,
      read: false,
      created_at: new Date().toISOString()
    };

    await chatRepo.append(msg);

    await auditRepo.log({
      user_id: userId,
      request_id: requestId,
      agent: this.name,
      action: `proactive_note_${type}`,
      result: { noteId: msg.id }
    });

    return msg;
  }
}

export const orchestratorAgent = new OrchestratorAgent();
