# RadioChat repair audit — 2026-08-29

## Scope

Repair branch only. Production source is not modified by this branch.

## Confirmed findings

1. AI proxy JWT handling decoded payloads without cryptographic signature verification.
2. Skip-mode requests could reach server-side AI provider credentials.
3. TTS accepted any non-empty Bearer token before using the server ElevenLabs key.
4. AI file preprocessing was unauthenticated while using server-funded AI keys.
5. Stripe webhook signature verification was disabled.
6. Billing client routes did not match the deployed `/api/billing` function contract.
7. Billing/profile code referenced stale database columns (`plan`, `plan_id`, `preferences`) that are not present in the current production schema.
8. Existing users can have no workspace, preventing API-key vault lookup.
9. Service-role conversation writes did not verify conversation ownership before message insertion.
10. Pricing UI limits were stale relative to the production billing plan records.

## Changes in this branch

- Added shared server authentication/CORS helpers using Supabase Auth token verification.
- Protected AI, TTS, preprocessing and key-vault server functions.
- Removed anonymous access to server-funded AI requests.
- Added ownership checks for service-role conversation mutations.
- Aligned profile reads/writes to the current production schema and made billing fields server-managed.
- Aligned billing client and server routing and plan mapping.
- Added Stripe Checkout/Portal REST integration with explicit failure when Stripe Price IDs are not configured.
- Added Stripe webhook HMAC signature verification and current subscription schema mapping.
- Added automatic workspace recovery for accounts created before the workspace trigger.
- Aligned displayed Free/€9.90/€24.90 plan quotas with current production plan data.

## External configuration still required

- Stripe Price IDs for the paid plans are currently absent in the production `billing_plans` records. Checkout must remain disabled until valid Stripe price IDs are configured.
- Production deployment must only be considered repaired after preview build/runtime verification and functional smoke tests.
