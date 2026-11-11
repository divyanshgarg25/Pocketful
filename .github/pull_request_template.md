## What and why

<!-- One or two sentences. Link the issue or audit item. -->

## Security checklist

- [ ] No secrets, tokens, keys or real user data added (the CI secret scan must stay green)
- [ ] Anything that moves money or deletes data still goes through a pending approval and `/decide` (step-up verified), never executes directly
- [ ] New routes: authenticated, input validated with Zod, scoped to the caller's `user_id`, and documented in `openapi.yaml`
- [ ] New env vars: added to `apps/api/src/core/config.ts`, `.env.example` and, if required in production, `render.yaml` (the drift tests will fail otherwise)
- [ ] New DB tables: RLS enabled, client roles revoked, added to a new migration (never edit 001-004)
- [ ] New external origins (scripts, fonts, APIs): added to the CSP in `render.yaml` deliberately
- [ ] No demo identity or simulated money reachable by a real account
- [ ] Errors shown to users go through `describeApiError` (new server `ErrorCode`s need a message)

## Verification

- [ ] `npm run typecheck`, `npm run lint`, `npm test`
- [ ] `npm run test:db` if migrations or repos changed
- [ ] Manually checked the affected screen in a browser (UI changes are not covered by the unit tests)
