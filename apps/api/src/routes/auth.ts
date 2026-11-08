import { Router } from 'express';
import { createDevToken } from '../core/auth.js';
import { config } from '../core/config.js';
import { DEMO_USER, devTokenNameFor } from '../core/demo.js';

export const authRouter = Router();

authRouter.post('/api/auth/dev-token', async (req, res) => {
  if (config.NODE_ENV === 'production' || !config.AUTH_ALLOW_DEMO) {
    return res.status(403).json({
      ok: false,
      error: {
        code: 'FORBIDDEN',
        message: 'Dev tokens are strictly forbidden in production mode.'
      }
    });
  }

  const { userId, email, name } = req.body || {};
  try {
    const targetUserId = userId || DEMO_USER.id;
    const targetEmail = email || DEMO_USER.email;
    const targetName = name || devTokenNameFor(targetEmail);

    const token = await createDevToken(targetUserId, targetEmail, targetName);
    return res.status(200).json({
      ok: true,
      data: {
        token,
        user: {
          id: targetUserId,
          email: targetEmail,
          name: targetName
        }
      }
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to issue dev token'
      }
    });
  }
});
