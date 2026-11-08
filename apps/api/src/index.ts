import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './core/config.js';
import { authMiddleware } from './core/auth.js';
import { handleRouteError, sendError, ForbiddenError } from './core/errors.js';
import { healthzRouter } from './routes/healthz.js';
import { authRouter } from './routes/auth.js';
import { payRouter } from './routes/pay.js';
import { webhooksRouter } from './routes/webhooks.js';
import { onboardingRouter } from './routes/onboarding.js';
import { meRouter } from './routes/me.js';
import { walletRouter } from './routes/wallet.js';
import { subscriptionsRouter } from './routes/subscriptions.js';
import { approvalsRouter } from './routes/approvals.js';
import { stepUpRouter } from './routes/stepup.js';
import { plansRouter } from './routes/plans.js';
import { comfortSpaceRouter } from './routes/comfortSpace.js';
import { groupsRouter } from './routes/groups.js';
import { trackerRouter } from './routes/tracker.js';
import { learningRouter } from './routes/learning.js';
import { occasionsRouter } from './routes/occasions.js';
import { vaultRouter } from './routes/vault.js';
import { receiptRouter } from './routes/receipt.js';
import { chatRouter } from './routes/chat.js';
import { auditRouter } from './routes/audit.js';
import { jobRunner } from './jobs/runner.js';
import { logger } from './core/logger.js';

const app = express();

// 1. Trust proxy configuration (Render/Cloudflare/reverse proxies). The hop count is configuration, not a guess: too
// low and every client shares the proxy's IP (one user's traffic rate-limits everyone); too high and a client can
// spoof X-Forwarded-For to dodge rate limiting. See TRUST_PROXY_HOPS.
app.set('trust proxy', config.TRUST_PROXY_HOPS);

// 2. Early Request ID assignment & header propagation
app.use((req, res, next) => {
  const reqId =
    (req.headers['x-request-id'] as string) ||
    `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  (req as unknown as { requestId: string }).requestId = reqId;
  res.setHeader('x-request-id', reqId);
  next();
});

// 3. Security headers via Helmet
app.use(
  helmet({
    // The API serves JSON only, never HTML, so it can forbid everything. (The SPA's own CSP is set by its static host:
    // see the pocketful-web headers in render.yaml.)
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
        frameAncestors: ["'none'"]
      }
    },
    crossOriginEmbedderPolicy: false
  })
);

// 4. Strict CORS allowlist
const allowedOrigins = config.CORS_ORIGIN.split(',').map((o) => o.trim());
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile clients, curl, server-to-server)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new ForbiddenError(`Origin ${origin} not allowed by CORS`));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'x-idempotency-key',
      'x-request-id'
    ],
    exposedHeaders: ['x-request-id']
  })
);

// 5. Rate Limiting (General API limiter & tiered sensitive endpoint limiters, skipped in test mode)
const apiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => config.NODE_ENV === 'test',
  handler: (req, res) => {
    const reqId = (req as unknown as { requestId?: string }).requestId;
    sendError(res, 'RATE_LIMITED', 'Too many requests. Please try again later.', 429, undefined, reqId);
  }
});

const payRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => config.NODE_ENV === 'test',
  handler: (req, res) => {
    const reqId = (req as unknown as { requestId?: string }).requestId;
    sendError(res, 'RATE_LIMITED', 'Too many payment requests. Please try again later.', 429, undefined, reqId);
  }
});

const webhookRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => config.NODE_ENV === 'test',
  handler: (req, res) => {
    const reqId = (req as unknown as { requestId?: string }).requestId;
    sendError(res, 'RATE_LIMITED', 'Too many webhook requests.', 429, undefined, reqId);
  }
});

const approvalsRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => config.NODE_ENV === 'test',
  handler: (req, res) => {
    const reqId = (req as unknown as { requestId?: string }).requestId;
    sendError(res, 'RATE_LIMITED', 'Too many approval requests. Please try again later.', 429, undefined, reqId);
  }
});

app.use('/api', apiRateLimiter);
app.use('/pay', payRateLimiter);
app.use('/webhooks', webhookRateLimiter);
app.use('/api/approvals', approvalsRateLimiter);

// 6. Unauthenticated public routes & webhooks (must mount before body parser / auth)
app.use(webhooksRouter);
app.use(healthzRouter);

// 7. JSON body parser with strict 100kb limit
app.use(express.json({ limit: '100kb' }));

// 8. Body parser error interceptor (catches malformed JSON syntax & payload too large)
app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
  const reqId = (req as unknown as { requestId?: string }).requestId;
  if (err instanceof SyntaxError && 'body' in err) {
    sendError(res, 'VALIDATION_FAILED', 'Malformed JSON payload in request body', 400, undefined, reqId);
    return;
  }
  if (err && typeof err === 'object' && 'type' in err && err.type === 'entity.too.large') {
    sendError(res, 'VALIDATION_FAILED', 'Request payload exceeds 100kb size limit', 413, undefined, reqId);
    return;
  }
  next(err);
});

// 9. Public friend checkout page (unauthenticated)
app.use(payRouter);

// 10. Dev auth route (only accessible when AUTH_ALLOW_DEMO is true and not in production)
app.use(authRouter);

// 11. Authenticated API routes
app.use(authMiddleware);
app.use(onboardingRouter);
app.use(meRouter);
app.use(walletRouter);
app.use(subscriptionsRouter);
app.use(stepUpRouter);
app.use(approvalsRouter);
app.use(plansRouter);
app.use(comfortSpaceRouter);
app.use(groupsRouter);
app.use(trackerRouter);
app.use(learningRouter);
app.use(occasionsRouter);
app.use(vaultRouter);
app.use(receiptRouter);
app.use(chatRouter);
app.use(auditRouter);

// 12. Global Express error handler
app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const reqId = (req as unknown as { requestId?: string }).requestId;
  if (err instanceof Error && err.message.includes('not allowed by CORS')) {
    sendError(res, 'FORBIDDEN', err.message, 403, undefined, reqId);
    return;
  }
  handleRouteError(res, err, reqId);
});

// Start Server
if (process.env['NODE_ENV'] !== 'test') {
  const port = config.PORT;
  app.listen(port, () => {
    logger.info(`[Pocketful API] Server running on port ${port}`, { environment: config.NODE_ENV, port });
    logger.info(`[Pocketful API] Health check available at http://localhost:${port}/healthz`);
    jobRunner.initJobs();
  });
}

export default app;
