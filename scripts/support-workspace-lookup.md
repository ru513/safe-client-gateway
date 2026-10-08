<!--
  SPDX-License-Identifier: FSL-1.1-MIT
-->

# Internal workspace and subscription lookup

Find every workspace linked to a Safe or registered wallet address and inspect
its recorded subscriptions. This is an operator CLI with JSON output, using
authorized CGW database access; it does not require customer impersonation or
introduce a public endpoint. It creates no records, runs no migrations, and
performs its queries in one read-only, repeatable-read transaction.

Run from the CGW repository using its `.nvmrc` Node version (24.11.0 or a
compatible newer version; older Node 20 cannot load the installed ESM dependencies):

```bash
yarn support:workspace --address 0xADDRESS
yarn support:workspace --address 0xSAFE --kind safe --chain-id 1
yarn support:workspace --address 0xEOA --kind eoa
yarn support:workspace --space-id c2ae773f-64a7-4260-9b38-590634c7adfe
```

The command builds with the repository's TypeScript compiler and runs
`dist/scripts/support-workspace-lookup.js`. Build logs go to stderr so stdout
contains only the JSON report. After building once, operators can run the
compiled command directly with `node --env-file-if-exists=.env
dist/scripts/support-workspace-lookup.js` and the same arguments.

Supply the existing CGW database settings in the environment or `.env`.
`POSTGRES_HOST`, `POSTGRES_DB`, and `POSTGRES_USER` must be explicitly set to
avoid accidentally querying the default database. Use an authorized read-only
role and the existing `POSTGRES_PASSWORD`/`POSTGRES_SSL_*` configuration.
The schema must include CGW's field-encryption and subscription migrations.
This command does not provision access or apply migrations.

For encrypted data, use the target deployment's `ENCRYPTION_INDEX_KEY`,
`AWS_KMS_ENCRYPTION_KEY_ID`, `AWS_REGION`, and existing CGW KMS credentials
(`KMS_AWS_WEB_IDENTITY_TOKEN_FILE` or `KMS_AWS_ACCESS_KEY_ID` and
`KMS_AWS_SECRET_ACCESS_KEY`). The index key is **KMS-wrapped**, as in CGW;
do not substitute a plaintext HMAC key. Use the deployment's
`ENCRYPTION_ENABLED` setting. The command reuses CGW's encryption service and
only needs KMS decryption, not encryption or data-key generation. Secrets are
never accepted as command-line arguments or included in output.

The result includes:

- `linkedUsers`: user IDs registered to the wallet, including users with no
  workspace memberships. No emails or other wallets are returned.
- `workspaces`: every matching workspace UUID and decrypted name.
- `links`: Safe chain links and/or membership role and status. Memberships
  include active, invited, and declined records, with their status explicit.
- `subscriptions`: all recorded statuses and plans, including historical
  subscriptions, billing periods, last event time and update time.
- `occupiesActiveSlot`: whether CGW records `active` or `trialing` status.
- `periodEnded`: whether the stored period has ended at observation time;
  `null` means the date is unknown. A past date requires billing reconciliation.

The default address mode checks both paths. `--kind safe` checks `space_safes`;
`--kind eoa` follows `wallets → users → members → spaces`. This does not detect
whether an address has onchain code, discover Safes an EOA owns, or infer
workspace membership from Safe ownership. `--chain-id` filters only Safe links.
Subscriptions belong to each workspace, not to the Safe or EOA itself.

Names/plan labels in output are untrusted text if a downstream UI renders them.
The result contains internal customer relationships; keep it in internal
support tooling. Only existing database/KMS permissions authorize this CLI.

No live Stripe reconciliation or feature-entitlement calculation happens.
An empty subscription list means **no record in this CGW database**. It is not
proof of no subscription in Stripe. A plan label alone does not establish
Safe Pro migration. For current granted features, use CGW's authenticated
`GET /v1/spaces/{spaceId}/entitlements` endpoint.

There is no silent truncation: exceeding 1,000 links/users/subscriptions fails
the lookup. Each SQL statement has a 15-second timeout. Missing encryption
keys when indexed addresses exist, unavailable tables, and DB/KMS failures
fail the whole command with a nonzero exit code, never an empty success. CLI
DB/KMS errors are deliberately generic to keep driver errors from printing secrets;
`--help` works without database or KMS access.
