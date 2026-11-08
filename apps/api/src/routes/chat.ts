import { Router } from 'express';
import { z } from 'zod';
import { orchestratorAgent } from '../agents/orchestrator.js';
import { chatRepo } from '../repos/chat.js';
import { sendSuccess, handleRouteError } from '../core/errors.js';
import type { AuthenticatedRequest } from '../core/auth.js';

export const chatRouter = Router();

chatRouter.get('/api/chat', async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const messages = await chatRepo.getRecentMessages(authReq.userId, 20);
    sendSuccess(res, { messages }, authReq.requestId);
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});

const MessageInputSchema = z.object({
  message: z.string().trim().min(1).max(2000)
});

const ProactiveInputSchema = z.object({
  type: z.enum(['friday_brief', 'sunday_vault'])
});

chatRouter.post('/api/chat', async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const { message } = MessageInputSchema.parse(req.body);
    const response = await orchestratorAgent.processUserMessage(authReq.userId, message, authReq.requestId);

    sendSuccess(res, response, authReq.requestId);
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});

chatRouter.post('/api/chat/proactive', async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const { type } = ProactiveInputSchema.parse(req.body);
    const note = await orchestratorAgent.postProactiveNote(authReq.userId, type, authReq.requestId);
    sendSuccess(res, { note }, authReq.requestId);
  } catch (err) {
    handleRouteError(res, err, authReq.requestId);
  }
});
