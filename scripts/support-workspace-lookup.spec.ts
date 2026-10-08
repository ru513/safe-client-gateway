// SPDX-License-Identifier: FSL-1.1-MIT
import { faker } from '@faker-js/faker';
import { Builder } from '@/__tests__/builder';
import {
  type LookupCrypto,
  type LookupDatabase,
  lookupWorkspace,
  parseLookup,
} from './support-workspace-lookup';

describe('support workspace lookup', () => {
  const crypto: LookupCrypto = {
    blindIndex: () => faker.string.alphanumeric(),
    decrypt: async (value) => value,
  };

  it('validates addresses and mutually exclusive query modes before querying', () => {
    expect(parseLookup(['--help'])).toBeNull();
    expect(() => parseLookup([])).toThrow();
    expect(() => parseLookup(['--address', 'not-an-address'])).toThrow();
    expect(() =>
      parseLookup([
        '--space-id',
        faker.string.uuid(),
        '--address',
        faker.finance.ethereumAddress(),
      ]),
    ).toThrow();
    expect(() =>
      parseLookup(['--space-id', faker.string.uuid(), '--kind', 'safe']),
    ).toThrow();
    expect(() =>
      parseLookup([
        '--address',
        faker.finance.ethereumAddress(),
        '--kind',
        'eoa',
        '--chain-id',
        '1',
      ]),
    ).toThrow();
  });

  it('defaults to both Safe and registered-wallet relationships', () => {
    expect(
      parseLookup(['--address', faker.finance.ethereumAddress()]),
    ).toMatchObject({ type: 'address', kind: 'address' });
  });

  it('does not report missing encrypted addresses as no matches', async () => {
    const db: LookupDatabase = {
      query: vi.fn().mockResolvedValue([{ encrypted: true }]),
    };
    await expect(
      lookupWorkspace(
        db,
        { ...crypto, blindIndex: () => null },
        {
          type: 'address',
          kind: 'safe',
          address: faker.finance.ethereumAddress() as `0x${string}`,
        },
      ),
    ).rejects.toThrow('ENCRYPTION_INDEX_KEY');
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('propagates unavailable tables instead of returning an empty success', async () => {
    const db: LookupDatabase = {
      query: vi
        .fn()
        .mockRejectedValue(new Error('missing subscriptions table')),
    };
    await expect(
      lookupWorkspace(db, crypto, {
        type: 'space',
        spaceId: faker.string.uuid(),
      }),
    ).rejects.toThrow();
  });

  it('flags an expired active record without converting it to confirmed current Pro access', async () => {
    const now = faker.date.recent();
    const space = new Builder<{ id: number; uuid: string; name: string }>()
      .with('id', faker.number.int({ min: 1, max: 100000 }))
      .with('uuid', faker.string.uuid())
      .with('name', faker.company.name())
      .build();
    const sub = new Builder<{
      spaceId: number;
      id: string;
      status: string;
      planId: string;
      planName: string;
      planCode: null;
      currentPeriodStart: Date;
      currentPeriodEnd: Date;
      lastEventAt: Date;
      updatedAt: Date;
    }>()
      .with('spaceId', space.id)
      .with('id', faker.string.uuid())
      .with('status', 'active')
      .with('planId', faker.string.uuid())
      .with('planName', faker.commerce.productName())
      .with('planCode', null)
      .with('currentPeriodStart', faker.date.past({ refDate: now }))
      .with('currentPeriodEnd', new Date(now.getTime() - 1))
      .with('lastEventAt', faker.date.past({ refDate: now }))
      .with('updatedAt', faker.date.past({ refDate: now }))
      .build();
    const db: LookupDatabase = {
      query: vi
        .fn()
        .mockResolvedValueOnce([space])
        .mockResolvedValueOnce([sub]),
    };
    const report = await lookupWorkspace(
      db,
      crypto,
      { type: 'space', spaceId: space.uuid },
      now,
    );
    expect(report.workspaces[0].subscriptions[0]).toMatchObject({
      status: 'active',
      occupiesActiveSlot: true,
      periodEnded: true,
    });
    expect(report.workspaces[0]).not.toHaveProperty('isPro');
    expect(report.source).toBe('cgw_database_snapshot');
  });
});
