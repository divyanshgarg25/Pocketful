/**
 * Demo mode: a 1-click sign-in for local development. It is ON for `vite dev` and tests and OFF in production builds unless
 * VITE_ENABLE_DEMO=true is set deliberately. The API refuses demo tokens in production regardless (AUTH_ALLOW_DEMO),
 * so this flag only decides whether the demo UI and its prefilled identity exist in the bundle at all.
 */
declare const __DEMO_UI__: boolean; // injected by vite.config.ts `define`
export const DEMO_UI: boolean = __DEMO_UI__;

export interface DemoIdentity {
  id: string;
  email: string;
  name: string;
  password: string;
}

export const demoIdentity: DemoIdentity | null = DEMO_UI
  ? {
      id: '00000000-0000-4000-a000-000000000001',
      email: 'aarav@pocketful.demo',
      name: 'Aarav Sharma',
      password: 'weekend-ledger-2026'
    }
  : null;
