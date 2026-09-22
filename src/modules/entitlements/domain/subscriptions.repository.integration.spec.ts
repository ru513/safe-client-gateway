// SPDX-License-Identifier: FSL-1.1-MIT

import { randomUUID } from 'node:crypto';
import { faker } from '@faker-js/faker';
import type { ConfigService } from '@nestjs/config';
import { DataSource, type ObjectLiteral } from 'typeorm';
import type { MockedObject } from 'vitest';
import configuration from '@/config/entities/__tests__/configuration';
import { postgresConfig } from '@/config/entities/postgres.config';
import type { SubscriptionStatus } from '@/datasources/billing-api/entities/subscription.entity';
import { DatabaseMigrator } from '@/datasources/db/v2/database-migrator.service';
import { PostgresDatabaseService } from '@/datasources/db/v2/postgres-database.service';
import { nameBuilder } from '@/domain/common/entities/name.builder';
import type { ILoggingService } from '@/logging/logging.interface';
import { Feature } from '@/modules/entitlements/datasources/entities/feature.entity.db';
import { SpaceFeatureUsage } from '@/modules/entitlements/datasources/entities/space-feature-usage.entity.db';
import { SpaceSubscription } from '@/modules/entitlements/datasources/entities/space-subscription.entity.db';
import { SubscriptionEntitlement } from '@/modules/entitlements/datasources/entities/subscription-entitlement.entity.db';
import { SubscriptionsRepository } from '@/modules/entitlements/domain/subscriptions.repository';
import { SpaceSafe } from '@/modules/spaces/datasources/safes/entities/space-safes.entity.db';
import { Space } from '@/modules/spaces/datasources/spaces/entities/space.entity.db';
import { Member } from '@/modules/users/datasources/entities/member.entity.db';
import { User } from '@/modules/users/datasources/entities/users.entity.db';
import { Wallet } from '@/modules/wallets/datasources/entities/wallets.entity.db';

const mockLoggingService = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
} as MockedObject<ILoggingService>;

describe('SubscriptionsRepository', () => {
  let postgresDatabaseService: PostgresDatabaseService;
  let subscriptionsRepository: SubscriptionsRepository;

  // Not faker: a fixed FAKER_SEED would hand every spec file the same name.
  const testDatabaseName = `test_${randomUUID().replaceAll('-', '')}`;
  const testConfiguration = configuration();

  const dataSource = new DataSource({
    ...postgresConfig({
      ...testConfiguration.db.connection.postgres,
      type: 'postgres',
      database: testDatabaseName,
    }),
    migrationsTableName: testConfiguration.db.orm.migrationsTableName,
    entities: [
      Feature,
      Member,
      Space,
      SpaceFeatureUsage,
      SpaceSafe,
      SpaceSubscription,
      SubscriptionEntitlement,
      User,
      Wallet,
    ],
  });

  beforeAll(async () => {
    const testDataSource = new DataSource({
      ...postgresConfig({
        ...testConfiguration.db.connection.postgres,
        type: 'postgres',
        database: 'postgres',
      }),
    });
    const testPostgresDatabaseService = new PostgresDatabaseService(
      mockLoggingService,
      testDataSource,
    );
    await testPostgresDatabaseService.initializeDatabaseConnection();
    await testPostgresDatabaseService
      .getDataSource()
      .query(`CREATE DATABASE ${testDatabaseName}`);
    await testPostgresDatabaseService.destroyDatabaseConnection();

    postgresDatabaseService = new PostgresDatabaseService(
      mockLoggingService,
      dataSource,
    );
    await postgresDatabaseService.initializeDatabaseConnection();

    const mockConfigService = {
      getOrThrow: vi.fn().mockImplementation((key: string) => {
        if (key === 'db.migrator.numberOfRetries') {
          return testConfiguration.db.migrator.numberOfRetries;
        }
        if (key === 'db.migrator.retryAfterMs') {
          return testConfiguration.db.migrator.retryAfterMs;
        }
      }),
    } as MockedObject<ConfigService>;
    const migrator = new DatabaseMigrator(
      mockLoggingService,
      postgresDatabaseService,
      mockConfigService,
    );
    await migrator.migrate();

    subscriptionsRepository = new SubscriptionsRepository(
      postgresDatabaseService,
    );
  });

  afterEach(async () => {
    vi.resetAllMocks();

    // Delete in dependency order; the subscription rows reference the space.
    await deleteAll(SpaceSubscription);
    await deleteAll(Member);
    await deleteAll(Space);
    await deleteAll(User);
  });

  afterAll(async () => {
    await postgresDatabaseService.getDataSource().dropDatabase();
    await postgresDatabaseService.destroyDatabaseConnection();
  });

  async function deleteAll<T extends ObjectLiteral>(entity: {
    new (): T;
  }): Promise<void> {
    await dataSource
      .getRepository(entity)
      .createQueryBuilder()
      .delete()
      .execute();
  }

  async function createSpace(): Promise<Space['id']> {
    const inserted = await dataSource.getRepository(Space).insert({
      name: nameBuilder(),
      status: 'ACTIVE',
    });
    return inserted.generatedMaps[0].id as Space['id'];
  }

  // The status is what each case is about; the rest of the row is incidental.
  // Returns the plan id written, so a case can assert what it reads back.
  async function subscribe(
    spaceId: Space['id'],
    status: SubscriptionStatus,
    planId: string = faker.string.uuid(),
  ): Promise<string> {
    await subscriptionsRepository.upsertSubscription({
      spaceId,
      upstreamSubscriptionId: faker.string.uuid(),
      values: {
        status,
        planId,
        planName: nameBuilder(),
        currentPeriodStart: null,
        currentPeriodEnd: null,
        lastEventAt: null,
      },
    });
    return planId;
  }

  describe('hasActiveSubscriptionForUser', () => {
    async function createMember(
      spaceId: number,
      status: Member['status'] = 'ACTIVE',
      userId?: number,
      role: Member['role'] = 'MEMBER',
    ): Promise<number> {
      const id =
        userId ??
        ((await dataSource.getRepository(User).insert({ status: 'ACTIVE' }))
          .identifiers[0].id as number);
      await dataSource.getRepository(Member).insert({
        user: { id },
        space: { id: spaceId },
        name: nameBuilder(),
        status,
        role,
      });
      return id;
    }

    it.each([
      'active',
      'trialing',
      'canceled',
      'past_due',
      'unpaid',
      'paused',
      'incomplete',
      'incomplete_expired',
    ] as const)('follows billing subscription status %s', async (status) => {
      const spaceId = await createSpace();
      const userId = await createMember(spaceId);
      await subscribe(spaceId, status);
      await expect(
        subscriptionsRepository.hasActiveSubscriptionForUser(userId),
      ).resolves.toBe(status === 'active' || status === 'trialing');
    });

    it.each(['INVITED', 'DECLINED'] as const)(
      'excludes %s membership even with an active subscription',
      async (status) => {
        const spaceId = await createSpace();
        const userId = await createMember(spaceId, status);
        await subscribe(spaceId, 'active');
        await expect(
          subscriptionsRepository.hasActiveSubscriptionForUser(userId),
        ).resolves.toBe(false);
      },
    );

    it('checks all memberships in one query without loading feature data or requiring a Safe', async () => {
      const first = await createSpace();
      const userId = await createMember(first);
      await subscribe(first, 'canceled');
      const second = await createSpace();
      await createMember(second, 'ACTIVE', userId, 'ADMIN');
      await subscribe(second, 'active');
      const queries = vi.spyOn(dataSource.logger, 'logQuery');
      try {
        await expect(
          subscriptionsRepository.hasActiveSubscriptionForUser(userId),
        ).resolves.toBe(true);
        expect(queries).toHaveBeenCalledTimes(1);
        expect(queries.mock.calls[0][0]).toContain('EXISTS');
        expect(queries.mock.calls[0][0]).not.toContain('entitlements');
      } finally {
        queries.mockRestore();
      }
    });

    it('does not borrow another user subscription', async () => {
      const paid = await createSpace();
      await createMember(paid);
      await subscribe(paid, 'active');
      const free = await createSpace();
      const userId = await createMember(free);
      await expect(
        subscriptionsRepository.hasActiveSubscriptionForUser(userId),
      ).resolves.toBe(false);
    });

    it('immediately reflects cancellation and removed memberships without a cache', async () => {
      const spaceId = await createSpace();
      const userId = await createMember(spaceId);
      await subscribe(spaceId, 'active');
      await expect(
        subscriptionsRepository.hasActiveSubscriptionForUser(userId),
      ).resolves.toBe(true);
      await dataSource
        .getRepository(SpaceSubscription)
        .update({ space: { id: spaceId } }, { status: 'canceled' });
      await expect(
        subscriptionsRepository.hasActiveSubscriptionForUser(userId),
      ).resolves.toBe(false);
      await subscribe(spaceId, 'trialing');
      await expect(
        subscriptionsRepository.hasActiveSubscriptionForUser(userId),
      ).resolves.toBe(true);
      await dataSource.getRepository(Member).delete({ user: { id: userId } });
      await expect(
        subscriptionsRepository.hasActiveSubscriptionForUser(userId),
      ).resolves.toBe(false);
    });

    it('excludes a pending user and a non-active stored Workspace', async () => {
      const spaceId = await createSpace();
      const userId = await createMember(spaceId);
      await subscribe(spaceId, 'active');
      await dataSource
        .getRepository(User)
        .update(userId, { status: 'PENDING' });
      await expect(
        subscriptionsRepository.hasActiveSubscriptionForUser(userId),
      ).resolves.toBe(false);
      await dataSource.getRepository(User).update(userId, { status: 'ACTIVE' });
      // Boundary for an unknown/non-active numeric state; current SpaceStatus only exposes ACTIVE.
      await dataSource.query('UPDATE spaces SET status = $1 WHERE id = $2', [
        0,
        spaceId,
      ]);
      await expect(
        subscriptionsRepository.hasActiveSubscriptionForUser(userId),
      ).resolves.toBe(false);
    });
  });

  describe('getSubscriptionSummary', () => {
    it('should report a space that never subscribed', async () => {
      const spaceId = await createSpace();

      await expect(
        subscriptionsRepository.getSubscriptionSummary(spaceId),
      ).resolves.toStrictEqual({
        hasEverSubscribed: false,
        activePlanId: null,
      });
    });

    it.each(['active', 'trialing'] as const)(
      'should report the plan id of a %s subscription',
      async (status) => {
        const spaceId = await createSpace();
        const planId = await subscribe(spaceId, status);

        await expect(
          subscriptionsRepository.getSubscriptionSummary(spaceId),
        ).resolves.toStrictEqual({
          hasEverSubscribed: true,
          activePlanId: planId,
        });
      },
    );

    // Every status outside ACTIVE_SUBSCRIPTION_STATUSES, listed literally
    // rather than derived from it: the point is to pin which side of the line
    // each one falls on, which a list computed from that constant could not do.
    it.each([
      'canceled',
      'incomplete',
      'incomplete_expired',
      'past_due',
      'paused',
      'unpaid',
    ] as const)(
      'should report a %s subscription as subscribed but on no plan',
      async (status) => {
        const spaceId = await createSpace();
        await subscribe(spaceId, status);

        await expect(
          subscriptionsRepository.getSubscriptionSummary(spaceId),
        ).resolves.toStrictEqual({
          hasEverSubscribed: true,
          activePlanId: null,
        });
      },
    );

    it('should keep the active plan id when a terminal row also exists', async () => {
      const spaceId = await createSpace();
      await subscribe(spaceId, 'canceled');
      const planId = await subscribe(spaceId, 'active');

      await expect(
        subscriptionsRepository.getSubscriptionSummary(spaceId),
      ).resolves.toStrictEqual({
        hasEverSubscribed: true,
        activePlanId: planId,
      });
    });

    it('should not leak another space subscriptions', async () => {
      const [spaceId, otherSpaceId] = await Promise.all([
        createSpace(),
        createSpace(),
      ]);
      await subscribe(otherSpaceId, 'active');

      await expect(
        subscriptionsRepository.getSubscriptionSummary(spaceId),
      ).resolves.toStrictEqual({
        hasEverSubscribed: false,
        activePlanId: null,
      });
    });
  });
});
