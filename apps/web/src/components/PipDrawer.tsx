import { logError } from '../lib/log';
import React, { useState, useEffect, useRef } from 'react';
import { apiFetch, sealApproval } from '../lib/api';
import { notifyError } from '../lib/errors';
import { ApprovalSeal } from './ApprovalSeal';
import { Badge } from './Badge';
import { useModalA11y } from '../lib/useModalA11y';
import { toast } from '../lib/toast';

interface PipDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onNavigateTab?: (tab: 'ledger' | 'plan' | 'group' | 'spend' | 'occasions' | 'you') => void;
}

interface GhostItem {
  id: string;
  merchant: string;
  amount: string;
  reason: string;
}

interface PlanSlotItem {
  slot: string;
  suggestionId: string;
  name: string;
  category: string;
  distKm: number;
  costRange: string;
  headline: string;
  why: string;
}

interface LearnedLineItem {
  text: string;
  evidence?: string;
  weight?: number;
}

interface CardPayload {
  type: string;
  yearlyWaste?: string;
  ghosts?: GhostItem[];
  planId?: string;
  slots?: PlanSlotItem[];
  lines?: LearnedLineItem[];
  [key: string]: unknown;
}

interface PendingApprovalItem {
  id: string;
  agent: string;
  action_type: string;
  preview: string;
  sealed?: boolean;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'pip' | 'system';
  content: string;
  cards?: CardPayload[] | null;
  pendingApprovals?: PendingApprovalItem[] | null;
  proactive?: boolean;
}

export const PipDrawer: React.FC<PipDrawerProps> = ({ isOpen, onClose, onNavigateTab }) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sealedApprovalIds, setSealedApprovalIds] = useState<string[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const modalRef = useModalA11y(isOpen, onClose);

  const loadMessages = async () => {
    try {
      const res = await apiFetch<{ messages: ChatMessage[] }>('/api/chat');
      setMessages(res.messages || []);
    } catch (err) {
      logError('Failed to load chat history:', err);
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadMessages();
    }
  }, [isOpen]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const handleSend = async (textToSend?: string) => {
    const text = (textToSend || input).trim();
    if (!text || loading) return;

    setInput('');
    setLoading(true);

    // Optimistic user message
    const tempUserMsg: ChatMessage = {
      id: `temp_${Date.now()}`,
      role: 'user',
      content: text
    };
    setMessages((prev) => [...prev, tempUserMsg]);

    try {
      const res = await apiFetch<{
        reply: string;
        cards?: CardPayload[];
        pendingApprovals?: PendingApprovalItem[];
      }>('/api/chat', {
        method: 'POST',
        body: JSON.stringify({ message: text })
      });

      const botMsg: ChatMessage = {
        id: `bot_${Date.now()}`,
        role: 'pip',
        content: res.reply,
        cards: res.cards,
        pendingApprovals: res.pendingApprovals
      };
      setMessages((prev) => [...prev, botMsg]);
    } catch (err) {
      const errMsg: ChatMessage = {
        id: `err_${Date.now()}`,
        role: 'pip',
        content: `I had trouble connecting to the ledger: ${err instanceof Error ? err.message : String(err)}. Nothing was moved.`
      };
      setMessages((prev) => [...prev, errMsg]);
    } finally {
      setLoading(false);
    }
  };

  const handleInlineSeal = async (approvalId: string) => {
    try {
      await sealApproval(approvalId, `pip_seal_${approvalId}_${Date.now()}`);
      setSealedApprovalIds((prev) => [...prev, approvalId]);
      toast.success('Approval sealed');
    } catch (err: unknown) {
      notifyError(err, 'Approval seal failed');
      throw err;
    }
  };

  if (!isOpen) return null;

  return (
    <>
      {/* Background Overlay Backdrop */}
      <div
        className="fixed inset-0 bg-ink/30 z-50 transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pip-drawer-title"
        className="fixed inset-y-0 right-0 w-full sm:w-[440px] bg-parchment border-l border-oat z-50 flex flex-col shadow-lift outline-none"
      >
      {/* Drawer Header */}
      <div className="p-4 border-b border-oat flex justify-between items-center bg-sand">
        <div className="flex items-center gap-2.5">
          <span className="w-7 h-7 rounded-full bg-burgundy border border-brass flex items-center justify-center font-display italic text-parchment text-sm font-bold shadow-lift">
            p
          </span>
          <div>
            <h3 id="pip-drawer-title" className="font-display font-semibold text-sm text-ink leading-tight">Pip</h3>
            <span className="text-[10px] text-taupe font-ui block">
              Autonomous Weekend Bookkeeper · AI Orchestrator
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-taupe hover:text-ink font-ui px-2 py-1 rounded-[2px] hover:bg-parchment border border-transparent hover:border-oat transition-colors focus:outline-none focus:ring-1 focus:ring-burgundy"
          aria-label="Close Pip chat"
        >
          ✕ Close
        </button>
      </div>

      {/* Suggested Quick Prompt Chips */}
      <div className="px-3 py-2 bg-linen border-b border-oat flex gap-1.5 overflow-x-auto text-[11px] font-ui whitespace-nowrap">
        <button
          type="button"
          onClick={() => handleSend('Audit my subscriptions')}
          className="px-2.5 py-1 bg-parchment border border-oat rounded-[2px] text-ink hover:bg-sand transition-colors"
        >
          "Audit subscriptions"
        </button>
        <button
          type="button"
          onClick={() => handleSend('Something quiet under $15')}
          className="px-2.5 py-1 bg-parchment border border-oat rounded-[2px] text-ink hover:bg-sand transition-colors"
        >
          "Quiet spot under $15"
        </button>
        <button
          type="button"
          onClick={() => handleSend('What have you learned about me?')}
          className="px-2.5 py-1 bg-parchment border border-oat rounded-[2px] text-ink hover:bg-sand transition-colors"
        >
          "What you learned"
        </button>
        <button
          type="button"
          onClick={() => handleSend('Show my wallet balance')}
          className="px-2.5 py-1 bg-parchment border border-oat rounded-[2px] text-ink hover:bg-sand transition-colors"
        >
          "Free cash"
        </button>
      </div>

      {/* Chat Messages Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs font-ui">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
          >
            {msg.role === 'pip' && (
              <span className="text-[10px] text-taupe uppercase tracking-wider mb-1 font-semibold flex items-center gap-1">
                <span>Pip</span>
                <span>·</span>
                <span className="font-normal lowercase">bookkeeper</span>
              </span>
            )}
            <div
              className={`p-3 rounded-[2px] max-w-[90%] leading-relaxed ${
                msg.role === 'user'
                  ? 'bg-burgundy text-parchment font-medium shadow-lift'
                  : 'bg-sand border border-oat text-ink shadow-lift'
              }`}
            >
              <div className="whitespace-pre-line">{msg.content}</div>

              {/* Dynamic JSON Cards Rendered by Agent Orchestrator */}
              {msg.cards && msg.cards.length > 0 && (
                <div className="mt-3 space-y-2 pt-2 border-t border-oat/70">
                  {msg.cards.map((card, cIdx) => (
                    <div key={cIdx}>
                      {/* 1. Subscription Audit Summary Card */}
                      {card.type === 'audit_summary' && (
                        <div className="p-2.5 bg-parchment border border-burgundy/40 rounded-[2px]">
                          <div className="flex justify-between items-center mb-1.5">
                            <span className="font-semibold text-burgundy text-[11px]">
                              Ghost Subscriptions Identified
                            </span>
                            <span className="font-num font-semibold text-brick text-[11px]">
                              {card.yearlyWaste} / yr
                            </span>
                          </div>
                          {card.ghosts && card.ghosts.length > 0 && (
                            <div className="divide-y divide-oat border-t border-b border-oat my-1.5">
                              {card.ghosts.slice(0, 3).map((g) => (
                                <div key={g.id} className="py-1 flex justify-between text-[10px]">
                                  <span className="font-medium text-ink">{g.merchant}</span>
                                  <span className="font-num text-taupe">{g.amount}/mo</span>
                                </div>
                              ))}
                            </div>
                          )}
                          {onNavigateTab && (
                            <button
                              type="button"
                              onClick={() => {
                                onNavigateTab('ledger');
                                onClose();
                              }}
                              className="w-full mt-1.5 py-1 bg-burgundy text-parchment text-[10px] font-medium rounded-[2px] hover:bg-claret text-center"
                            >
                              Review & Cancel in Ledger →
                            </button>
                          )}
                        </div>
                      )}

                      {/* 2. Plan Ticket Stubs Card */}
                      {card.type === 'plan_tickets' && card.slots && (
                        <div className="space-y-1.5">
                          <span className="font-semibold text-ink text-[11px] block">
                            Recommended Weekend Tickets:
                          </span>
                          {card.slots.map((slot, sIdx) => (
                            <div
                              key={sIdx}
                              className="p-2 bg-parchment border border-oat rounded-[2px] text-[11px]"
                            >
                              <div className="flex justify-between items-center mb-0.5">
                                <span className="font-semibold text-ink">{slot.name}</span>
                                <Badge type="moss">{slot.slot.toUpperCase()}</Badge>
                              </div>
                              <div className="flex justify-between text-[10px] text-taupe mb-1">
                                <span>{slot.category} · {slot.distKm} km</span>
                                <span className="font-num font-medium text-ink">{slot.costRange}</span>
                              </div>
                              <p className="text-[10px] text-taupe italic">"{slot.why}"</p>
                            </div>
                          ))}
                          {onNavigateTab && (
                            <button
                              type="button"
                              onClick={() => {
                                onNavigateTab('plan');
                                onClose();
                              }}
                              className="w-full mt-1 py-1 bg-burgundy text-parchment text-[10px] font-medium rounded-[2px] hover:bg-claret text-center"
                            >
                              View Full Plan Tickets →
                            </button>
                          )}
                        </div>
                      )}

                      {/* 3. Learned Profile Lines Card */}
                      {card.type === 'learned_profile' && card.lines && (
                        <div className="p-2 bg-parchment border border-oat rounded-[2px] space-y-1 text-[11px]">
                          <span className="font-semibold text-ink block text-[11px]">
                            Tree-Ring Learned Priors:
                          </span>
                          {card.lines.map((line, lIdx) => (
                            <div key={lIdx} className="text-taupe leading-tight">
                              • {line.text}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Pending Approvals with Guardian Seal */}
              {msg.pendingApprovals && msg.pendingApprovals.length > 0 && (
                <div className="mt-3 pt-2 border-t border-burgundy/30 space-y-2">
                  {msg.pendingApprovals.map((appr) => {
                    const isSealed = sealedApprovalIds.includes(appr.id);
                    return (
                      <div
                        key={appr.id}
                        className="p-2.5 bg-parchment border border-burgundy rounded-[2px]"
                      >
                        <span className="text-[10px] uppercase font-semibold text-burgundy block mb-1">
                          Guardian Approval Required
                        </span>
                        <p className="text-[11px] text-ink mb-2">{appr.preview}</p>

                        {isSealed ? (
                          <div className="p-1.5 bg-moss/20 text-moss rounded-[2px] text-[10px] text-center font-medium">
                            ✓ Sealed & Executed via PayPal Sandbox
                          </div>
                        ) : (
                          <div className="flex justify-center pt-1">
                            <ApprovalSeal
                              onApprove={() => handleInlineSeal(appr.id)}
                              size={56}
                              label="Hold to seal"
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex items-center gap-1.5 text-xs text-taupe py-2">
            <span className="w-1.5 h-1.5 bg-burgundy rounded-full animate-pulse" />
            <span className="w-1.5 h-1.5 bg-burgundy rounded-full animate-pulse [animation-delay:0.2s]" />
            <span className="w-1.5 h-1.5 bg-burgundy rounded-full animate-pulse [animation-delay:0.4s]" />
            <span className="text-[11px] ml-1">Pip is consulting the ledger...</span>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Chat Input */}
      <div className="p-3 border-t border-oat bg-sand flex gap-2">
        <input
          type="text"
          placeholder="Ask Pip anything..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          className="flex-1 bg-parchment border border-oat rounded-[2px] px-3 py-2 text-xs text-ink focus:outline-none focus:border-burgundy"
        />
        <button
          type="button"
          disabled={loading || !input.trim()}
          onClick={() => handleSend()}
          className={`px-4 py-2 bg-burgundy text-parchment text-xs font-medium rounded-[2px] transition-colors shadow-lift ${
            loading || !input.trim() ? 'opacity-50 cursor-not-allowed' : 'hover:bg-claret'
          }`}
        >
          Send
        </button>
      </div>
    </div>
    </>
  );
};
