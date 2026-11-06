/**
 * The local demo user. Used ONLY by the in-memory seed and by the dev-token endpoint/helper, both of which are
 * unavailable in production (boot guard + AUTH_ALLOW_DEMO). Real accounts must never receive any of these values:
 * their name comes from their own sign-up, never from here.
 */
export const DEMO_USER = {
  id: '00000000-0000-4000-a000-000000000001',
  email: 'aarav@pocketful.demo',
  name: 'Aarav Sharma'
} as const;

/** Display name used for a real account that has not provided one yet. */
export const DEFAULT_MEMBER_NAME = 'Pocketful Member';

/** Name to put in a dev token when the caller did not supply one: the demo user keeps its name, others use their email handle. */
export function devTokenNameFor(email: string): string {
  return email === DEMO_USER.email ? DEMO_USER.name : (email.split('@')[0] || DEFAULT_MEMBER_NAME);
}
