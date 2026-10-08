// SPDX-License-Identifier: FSL-1.1-MIT
import { faker } from '@faker-js/faker';
import { DataSource, type QueryRunner } from 'typeorm';
import configuration from '@/config/entities/__tests__/configuration';
import { postgresConfig } from '@/config/entities/postgres.config';
import { type LookupCrypto, lookupWorkspace } from './support-workspace-lookup';

// Only temporary tables on a dedicated connection; no application tables or
// migrations are modified. Exercises the actual PostgreSQL joins and casts.
describe('support workspace lookup SQL', () => {
  let db: DataSource;
  let runner: QueryRunner;
  const address = faker.finance.ethereumAddress() as `0x${string}`;
  const index = faker.string.alphanumeric(43);
  const spaceIds = [faker.string.uuid(), faker.string.uuid()];
  const crypto: LookupCrypto = {
    blindIndex: () => index,
    decrypt: async (value) => value,
  };
  beforeAll(async () => {
    const config = configuration();
    db = new DataSource({
      ...postgresConfig({ ...config.db.connection.postgres, type: 'postgres' }),
      entities: [],
      migrations: [],
      synchronize: false,
      logging: false,
      cache: false,
    });
    await db.initialize();
    runner = db.createQueryRunner();
    await runner.connect();
  });
  afterAll(async () => {
    await runner?.release();
    if (db?.isInitialized) await db.destroy();
  });
  beforeEach(async () => {
    // Tables survive the setup transaction, then disappear when the test
    // connection closes. Each read runs in a genuinely read-only transaction.
    await runner.query(`
      CREATE TEMP TABLE IF NOT EXISTS spaces (id integer, uuid uuid, name text);
      CREATE TEMP TABLE IF NOT EXISTS users (id integer, status integer);
      CREATE TEMP TABLE IF NOT EXISTS wallets (user_id integer, address text, address_index text);
      CREATE TEMP TABLE IF NOT EXISTS members (space_id integer, user_id integer, role integer, status integer);
      CREATE TEMP TABLE IF NOT EXISTS space_safes (space_id integer, chain_id text, address text, address_index text);
      CREATE TEMP TABLE IF NOT EXISTS subscriptions (id integer, space_id integer,
        upstream_subscription_id text, status text, plan_id text, plan_name text,
        plan_code text, current_period_start timestamptz, current_period_end timestamptz,
        last_event_at timestamptz, created_at timestamptz, updated_at timestamptz);
      TRUNCATE spaces, users, wallets, members, space_safes, subscriptions;
    `);
    await runner.query('INSERT INTO spaces VALUES (1, $1, $3), (2, $2, $4)', [
      ...spaceIds,
      faker.company.name(),
      faker.company.name(),
    ]);
    await runner.query('INSERT INTO users VALUES (1, 1)');
    await runner.query('INSERT INTO wallets VALUES (1, $1, $2)', [
      'kms:v1:synthetic',
      index,
    ]);
    await runner.query('INSERT INTO members VALUES (1, 1, 1, 1), (2, 1, 2, 0)');
    await runner.query(
      "INSERT INTO space_safes VALUES (1, '1', $1, NULL), (1, '8453', $2, $3), (2, '1', $2, $3)",
      [address.toUpperCase(), 'kms:v1:synthetic', index],
    );
    await runner.query(
      `INSERT INTO subscriptions VALUES
      (1, 1, $1, 'active', $3, $5, NULL, now() - interval '60 days', now() - interval '30 days', now(), now(), now()),
      (2, 1, $2, 'canceled', $4, $6, NULL, NULL, NULL, now(), now(), now())`,
      [
        faker.string.uuid(),
        faker.string.uuid(),
        faker.string.uuid(),
        faker.string.uuid(),
        faker.commerce.productName(),
        faker.commerce.productName(),
      ],
    );
    await runner.startTransaction('REPEATABLE READ');
    await runner.query('SET TRANSACTION READ ONLY');
  });
  afterEach(async () => {
    if (runner?.isTransactionActive) await runner.rollbackTransaction();
  });

  it('finds every workspace across plaintext/encrypted links and preserves chain and membership distinctions', async () => {
    const report = await lookupWorkspace(runner, crypto, {
      type: 'address',
      address,
      kind: 'address',
    });
    expect(report.workspaces).toHaveLength(2);
    const first = report.workspaces.find((s) => s.spaceId === spaceIds[0]);
    expect(first?.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'safe', chainId: '1' }),
        expect.objectContaining({ kind: 'safe', chainId: '8453' }),
        expect.objectContaining({
          kind: 'member',
          role: 'ADMIN',
          status: 'ACTIVE',
        }),
      ]),
    );
    expect(first?.subscriptions).toHaveLength(2);
    expect(
      first?.subscriptions.find((s) => s.status === 'active')?.periodEnded,
    ).toBe(true);
    expect(
      first?.subscriptions.find((s) => s.status === 'canceled')
        ?.occupiesActiveSlot,
    ).toBe(false);
    const second = report.workspaces.find((s) => s.spaceId === spaceIds[1]);
    expect(second?.subscriptions).toEqual([]);
    expect(second?.links).toContainEqual(
      expect.objectContaining({ kind: 'member', status: 'INVITED' }),
    );
  });

  it('filters Safe chains without returning unrelated member links in Safe-only mode', async () => {
    const report = await lookupWorkspace(runner, crypto, {
      type: 'address',
      address,
      kind: 'safe',
      chainId: '8453',
    });
    expect(report.workspaces).toHaveLength(1);
    expect(report.workspaces[0].spaceId).toBe(spaceIds[0]);
    expect(report.workspaces[0].links).toHaveLength(1);
    expect(report.linkedUsers).toEqual([]);
  });

  it('finds EOA memberships without treating attached Safes as membership', async () => {
    const report = await lookupWorkspace(runner, crypto, {
      type: 'address',
      address,
      kind: 'eoa',
    });
    expect(report.linkedUsers).toEqual([{ id: 1, status: 'ACTIVE' }]);
    expect(report.workspaces).toHaveLength(2);
    expect(
      report.workspaces.every((s) => s.links.every((l) => l.kind === 'member')),
    ).toBe(true);
  });

  it('accepts a space UUID without needing an address index', async () => {
    const report = await lookupWorkspace(
      runner,
      { ...crypto, blindIndex: () => null },
      { type: 'space', spaceId: spaceIds[0] },
    );
    expect(report.workspaces).toHaveLength(1);
    expect(report.workspaces[0].subscriptions).toHaveLength(2);
  });

  it('refuses an incomplete address search when encrypted rows exist but the index key is absent', async () => {
    await expect(
      lookupWorkspace(
        runner,
        { ...crypto, blindIndex: () => null },
        { type: 'address', address, kind: 'safe' },
      ),
    ).rejects.toThrow('ENCRYPTION_INDEX_KEY');
  });
});
