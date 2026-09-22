<!--
  SPDX-License-Identifier: FSL-1.1-MIT
 -->

# Authenticated support

`POST /v1/support/session` authenticates the gateway cookie; no request body is
required. It returns `{ appId, email, identityType, jwt, expiresAt, supportEligible }`
with a ten-minute Pylon JWT and `Cache-Control: no-store`.

OIDC uses the stored verified email; SIWE checks the current wallet association
and derives a private alias. Premium support requires an active user and active
membership in any active Workspace with an `active` or `trialing` subscription.
Other authenticated users receive help-only. Eligibility uses CGW's existing
billing records, independent of the selected Workspace.

## Setup and rollout

1. **CGW:** reuse existing [authentication](../auth/AUTH.md) and
   [billing](../billing/README.md). Provision both widget IDs, JWT secrets and
   `PYLON_WALLET_ALIAS_SECRET`, then restart. No Pylon settings means no support
   endpoint; partial configuration fails startup. See
   [`.env.sample.json`](../../../.env.sample.json). The alias secret must be stable,
   separate per environment and at least 32 characters; rotation changes identities.
2. **Host:** use three distinct widgets: existing HMAC, help-only JWT (Chat off),
   and premium JWT (Chat on). JWT IDs must match CGW. When adding JWT configuration,
   move the original ID to `NEXT_PUBLIC_PYLON_LEGACY_APP_ID`; retain its HMAC secret
   and alias domain. Allow exact Wallet origins in parent messaging and CSP.
3. **Wallet:** set `NEXT_PUBLIC_PYLON_CHAT_URL` to the host's `/chat` URL and enable
   Config Service `SUPPORT_CHAT`. Rebuild after changing public frontend settings.

Deploy **host → CGW → Wallet**. Pass only Pylon settings into the iframe, never
Auth0 tokens or gateway cookies. The Wallet flag hides the UI; it does not disable
the authenticated endpoint or revoke existing Pylon sessions.

## Manual check

Use staging credentials or trusted local HTTPS with matching Auth0 callbacks and
host origins. Keep credentials and test helpers outside the repositories.

- Test verified-email and wallet-only sign-in. Sign out and sign a new SIWE message
  when changing users; switching the connected wallet alone is insufficient.
- Verify help-only without a subscription, premium after an `active`/`trialing`
  billing update, then help-only after cancellation if no other Workspace qualifies.
  Reopen support after each change. For local webhook setup, see the billing guide.
- Check the legacy client, logout, retry and both Wallet entry points. Confirm
  conversation continuity manually; wallet aliases cannot receive email.

Developer checks: `yarn test src/modules/support`, `yarn build`,
`yarn env:validate:silent`.
