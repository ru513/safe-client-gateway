// SPDX-License-Identifier: FSL-1.1-MIT
import { parseArgs } from 'node:util';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import configuration from '@/config/entities/configuration';
import { postgresConfig } from '@/config/entities/postgres.config';
import { SubscriptionStatusSchema } from '@/datasources/billing-api/entities/subscription.entity';
import { AwsKmsService } from '@/datasources/kms/aws-kms.service';
import { KmsEncryptionService } from '@/datasources/kms/kms-encryption.service';
import { isActiveSubscriptionStatus } from '@/modules/entitlements/domain/entitlements.constants';
import {
  MemberRole,
  MemberStatus,
} from '@/modules/users/domain/entities/member.entity';
import { UserStatus } from '@/modules/users/domain/entities/user.entity';
import { AddressSchema } from '@/validation/entities/schemas/address.schema';
import { NumericStringSchema } from '@/validation/entities/schemas/numeric-string.schema';

const MAX_MATCHES = 1000;
const STATEMENT_TIMEOUT_MS = 15000;
// Only operator-facing messages constructed here are safe to print. Never
// print arbitrary DB/KMS error messages, which can contain connection secrets.
class LookupInputError extends Error {}
const HELP = `Read-only internal CGW workspace/subscription lookup. JSON output.

  yarn support:workspace --address 0x... [--kind safe|eoa|address] [--chain-id 1]
  yarn support:workspace --space-id UUID

The default kind searches both Safe links and linked user wallets. EOA mode
means a linked wallet lookup; it does not classify onchain code or find owned
Safes. --chain-id filters Safe links only and cannot be used with --kind eoa.
Requires explicit POSTGRES_HOST, POSTGRES_DB, POSTGRES_USER and authorized
database access. Uses existing CGW encryption/KMS configuration when needed.
`;

export const LookupSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('space'), spaceId: z.uuid() }),
  z
    .object({
      type: z.literal('address'),
      address: AddressSchema,
      kind: z.enum(['address', 'safe', 'eoa']),
      chainId: NumericStringSchema.optional(),
    })
    .refine((value) => value.kind !== 'eoa' || !value.chainId, {
      message: '--chain-id applies to Safe links, not EOA membership',
    }),
]);
export type Lookup = z.infer<typeof LookupSchema>;

const SpaceRow = z.object({
  id: z.number().int(),
  uuid: z.uuid(),
  name: z.string(),
});
const LinkRow = z.object({
  spaceId: z.number().int(),
  kind: z.enum(['safe', 'member']),
  chainId: z.string().nullable(),
  userId: z.number().int().nullable(),
  role: z.number().int().nullable(),
  status: z.number().int().nullable(),
});
const UserRow = z.object({ id: z.number().int(), status: z.number().int() });
const SubscriptionRow = z.object({
  spaceId: z.number().int(),
  id: z.string(),
  status: SubscriptionStatusSchema,
  planId: z.string(),
  planName: z.string().nullable(),
  planCode: z.string().nullable(),
  currentPeriodStart: z.date().nullable(),
  currentPeriodEnd: z.date().nullable(),
  lastEventAt: z.date().nullable(),
  updatedAt: z.date(),
});

// Small seams let tests exercise the lookup without booting the HTTP app,
// starting background workers, or possessing production credentials.
export interface LookupDatabase {
  query(sql: string, parameters?: Array<unknown>): Promise<unknown>;
}
export interface LookupCrypto {
  blindIndex(value: string): string | null;
  decrypt(value: string, context: Record<string, string>): Promise<string>;
}

export function parseLookup(argv: Array<string>): Lookup | null {
  const { values } = parseArgs({
    args: argv,
    options: {
      address: { type: 'string' },
      'space-id': { type: 'string' },
      kind: { type: 'string' },
      'chain-id': { type: 'string' },
      help: { type: 'boolean' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) return null;
  if (Boolean(values.address) === Boolean(values['space-id'])) {
    throw new LookupInputError(
      'Provide exactly one of --address or --space-id',
    );
  }
  if (values['space-id']) {
    if (values.kind || values['chain-id']) {
      throw new LookupInputError('--kind and --chain-id require --address');
    }
    return LookupSchema.parse({ type: 'space', spaceId: values['space-id'] });
  }
  return LookupSchema.parse({
    type: 'address',
    address: values.address,
    kind: values.kind ?? 'address',
    chainId: values['chain-id'],
  });
}

function enforceBound(count: number): void {
  if (count > MAX_MATCHES) {
    throw new LookupInputError(
      'Too many matches; narrow the lookup. No partial result returned.',
    );
  }
}

export async function lookupWorkspace(
  db: LookupDatabase,
  crypto: LookupCrypto,
  input: Lookup,
  observedAt: Date = new Date(),
): Promise<{
  source: string;
  observedAt: Date;
  lookup: Lookup;
  linkedUsers: Array<{ id: number; status: string }>;
  workspaces: Array<{
    spaceId: string;
    name: string;
    links: Array<{
      kind: 'safe' | 'member';
      chainId: string | null;
      userId: number | null;
      role: string | null;
      status: string | null;
    }>;
    subscriptions: Array<
      z.infer<typeof SubscriptionRow> & {
        occupiesActiveSlot: boolean;
        periodEnded: boolean | null;
      }
    >;
  }>;
  notes: Array<string>;
}> {
  const lookup = LookupSchema.parse(input);
  const links: Array<z.infer<typeof LinkRow>> = [];
  let users: Array<z.infer<typeof UserRow>> = [];
  let spaces: Array<z.infer<typeof SpaceRow>>;
  if (lookup.type === 'space') {
    spaces = SpaceRow.array().parse(
      await db.query('SELECT id, uuid, name FROM spaces WHERE uuid = $1', [
        lookup.spaceId,
      ]),
    );
  } else {
    const index = crypto.blindIndex(lookup.address);
    const tablesByKind = {
      safe: ['space_safes'],
      eoa: ['wallets'],
      address: ['space_safes', 'wallets'],
    };
    const tables = tablesByKind[lookup.kind];
    if (index === null) {
      // Detect encryption even when the flag is disabled after a rollback.
      // Without the index key an empty result would be a false negative.
      for (const table of tables) {
        const result = z.array(z.object({ encrypted: z.boolean() })).parse(
          await db.query(`SELECT EXISTS (SELECT 1 FROM ${table}
            WHERE address_index IS NOT NULL OR address LIKE 'kms:%') AS encrypted`),
        );
        if (result.some((row) => row.encrypted)) {
          throw new LookupInputError(
            'Encrypted addresses exist; configure ENCRYPTION_INDEX_KEY and KMS access before searching.',
          );
        }
      }
    }
    // Matches plaintext and encrypted rows during backfill/rollback, using
    // the existing shared crypto service for the persisted index format.
    if (lookup.kind !== 'eoa') {
      links.push(
        ...LinkRow.array().parse(
          await db.query(
            `
        SELECT space_id AS "spaceId", 'safe' AS kind, chain_id AS "chainId",
               NULL::integer AS "userId", NULL::integer AS role, NULL::integer AS status
        FROM space_safes
        WHERE ((address_index IS NULL AND lower(address) = $1) OR address_index = $2)
          AND ($3::text IS NULL OR chain_id = $3)
        ORDER BY space_id, chain_id LIMIT $4`,
            [
              lookup.address.toLowerCase(),
              index,
              lookup.chainId ?? null,
              MAX_MATCHES + 1,
            ],
          ),
        ),
      );
    }
    if (lookup.kind !== 'safe') {
      users = UserRow.array().parse(
        await db.query(
          `
        SELECT DISTINCT u.id, u.status FROM wallets w JOIN users u ON u.id = w.user_id
        WHERE (w.address_index IS NULL AND lower(w.address) = $1) OR w.address_index = $2
        ORDER BY u.id LIMIT $3`,
          [lookup.address.toLowerCase(), index, MAX_MATCHES + 1],
        ),
      );
      enforceBound(users.length);
      if (users.length) {
        links.push(
          ...LinkRow.array().parse(
            await db.query(
              `
          SELECT space_id AS "spaceId", 'member' AS kind, NULL::text AS "chainId",
                 user_id AS "userId", role, status
          FROM members WHERE user_id = ANY($1::integer[])
          ORDER BY space_id, user_id LIMIT $2`,
              [users.map((u) => u.id), MAX_MATCHES + 1],
            ),
          ),
        );
      }
    }
    enforceBound(links.length);
    spaces = links.length
      ? SpaceRow.array().parse(
          await db.query(
            'SELECT id, uuid, name FROM spaces WHERE id = ANY($1::integer[]) ORDER BY uuid',
            [[...new Set(links.map((link) => link.spaceId))]],
          ),
        )
      : [];
  }
  const subscriptions = spaces.length
    ? SubscriptionRow.array().parse(
        await db.query(
          `
    SELECT space_id AS "spaceId", upstream_subscription_id AS id, status,
           plan_id AS "planId", plan_name AS "planName", plan_code AS "planCode",
           current_period_start AS "currentPeriodStart", current_period_end AS "currentPeriodEnd",
           last_event_at AS "lastEventAt", updated_at AS "updatedAt"
    FROM subscriptions WHERE space_id = ANY($1::integer[])
    ORDER BY space_id, created_at DESC, id DESC LIMIT $2`,
          [spaces.map((space) => space.id), MAX_MATCHES + 1],
        ),
      )
    : [];
  enforceBound(subscriptions.length);
  return {
    source: 'cgw_database_snapshot',
    observedAt,
    lookup,
    linkedUsers: users.map((u) => ({
      id: u.id,
      status: UserStatus[u.status] ?? `UNKNOWN_${u.status}`,
    })),
    workspaces: await Promise.all(
      spaces.map(async (space) => ({
        spaceId: space.uuid,
        name: await crypto.decrypt(space.name, { spaceId: String(space.id) }),
        links: links
          .filter((link) => link.spaceId === space.id)
          .map((link) => ({
            kind: link.kind,
            chainId: link.chainId,
            userId: link.userId,
            role:
              link.role === null
                ? null
                : (MemberRole[link.role] ?? `UNKNOWN_${link.role}`),
            status:
              link.status === null
                ? null
                : (MemberStatus[link.status] ?? `UNKNOWN_${link.status}`),
          })),
        subscriptions: subscriptions
          .filter((sub) => sub.spaceId === space.id)
          .map((sub) => ({
            ...sub,
            occupiesActiveSlot: isActiveSubscriptionStatus(sub.status),
            periodEnded:
              sub.currentPeriodEnd === null
                ? null
                : sub.currentPeriodEnd <= observedAt,
          })),
      })),
    ),
    notes: [
      'Subscriptions belong to workspaces, not directly to addresses.',
      'EOA links are registered user memberships, including invitations/declined memberships; signing authority alone is not membership.',
      'CGW subscription records may lag billing. An empty list means no subscription recorded here, not verified absence in Stripe.',
      'Plan identifiers/names are reported verbatim; no Safe Pro migration or current feature eligibility is inferred.',
      'A past period end on an active/trialing record requires reconciliation with billing.',
    ],
  };
}

export async function main(argv: Array<string>): Promise<void> {
  const lookup = parseLookup(argv);
  if (lookup === null) {
    process.stdout.write(HELP);
    return;
  }
  for (const key of ['POSTGRES_HOST', 'POSTGRES_DB', 'POSTGRES_USER']) {
    if (!process.env[key])
      throw new LookupInputError(
        `Set ${key} explicitly for the target CGW database`,
      );
  }
  const config = configuration();
  const configService = new ConfigService(config);
  const crypto = new KmsEncryptionService(
    configService,
    new AwsKmsService(configService),
  );
  await crypto.onModuleInit();
  const db = new DataSource({
    ...postgresConfig({ ...config.db.connection.postgres, type: 'postgres' }),
    synchronize: false,
    migrationsRun: false,
    migrations: [],
    entities: [],
    logging: false,
    cache: false,
    extra: { max: 1, connectionTimeoutMillis: STATEMENT_TIMEOUT_MS },
  });
  await db.initialize();
  const runner = db.createQueryRunner();
  try {
    await runner.connect();
    await runner.startTransaction('REPEATABLE READ');
    await runner.query('SET TRANSACTION READ ONLY');
    await runner.query(
      `SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`,
    );
    const report = await lookupWorkspace(runner, crypto, lookup);
    await runner.rollbackTransaction();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    try {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
    } finally {
      await runner.release();
      await db.destroy();
    }
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    // Driver/KMS errors can include credentials, query parameters or PII.
    const message =
      error instanceof LookupInputError
        ? error.message
        : 'Check arguments (--help), database/schema access and CGW encryption/KMS configuration.';
    process.stderr.write(`Lookup failed; no complete result. ${message}\n`);
    process.exitCode = 1;
  });
}
