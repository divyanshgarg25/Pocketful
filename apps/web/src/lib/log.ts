/**
 * Developer diagnostics for failures the UI already handles (and usually toasts). Silent in production builds so
 * raw error objects are not written to every user's browser console; visible under `vite dev`.
 * This is the only file in the web app allowed to touch `console` (see eslint.config.mjs).
 */
export function logError(context: string, err?: unknown): void {
  if (import.meta.env.DEV) console.error(`[pocketful] ${context}`, err);
}
