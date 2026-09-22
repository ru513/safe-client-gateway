// SPDX-License-Identifier: FSL-1.1-MIT
import type { MockedObject } from 'vitest';
import { siweAuthPayloadDtoBuilder } from '@/modules/auth/domain/entities/__tests__/auth-payload-dto.entity.builder';
import type { ISubscriptionsRepository } from '@/modules/entitlements/domain/subscriptions.repository.interface';
import { supportUserBuilder } from '@/modules/support/domain/entities/__tests__/support-user.builder';
import { SupportRepository } from '@/modules/support/domain/support.repository';
import type { IUsersRepository } from '@/modules/users/domain/users.repository.interface';

describe('SupportRepository', () => {
  const users = {
    findOneOrFail: vi.fn(),
    isActiveWalletOwner: vi.fn(),
  } as unknown as MockedObject<IUsersRepository>;
  const subscriptions = {
    hasActiveSubscriptionForUser: vi.fn(),
  } as unknown as MockedObject<ISubscriptionsRepository>;
  const repository = new SupportRepository(users, subscriptions);

  it('loads the active identity without hydrating memberships', async () => {
    const user = supportUserBuilder().build();
    users.findOneOrFail.mockResolvedValue(user);
    await expect(repository.getUser(user.id)).resolves.toBe(user);
    expect(users.findOneOrFail).toHaveBeenCalledWith({
      id: user.id,
      status: 'ACTIVE',
    });
  });

  it.each([false, true])(
    'uses the current database eligibility=%s instead of hydrated membership data',
    async (eligible) => {
      const user = supportUserBuilder().with('members', []).build();
      subscriptions.hasActiveSubscriptionForUser.mockResolvedValueOnce(
        eligible,
      );
      await expect(repository.isEligible(user)).resolves.toBe(eligible);
      expect(
        subscriptions.hasActiveSubscriptionForUser,
      ).toHaveBeenCalledExactlyOnceWith(user.id);
    },
  );

  it.each([false, true])(
    'checks current wallet ownership=%s without loading another user',
    async (linked) => {
      const user = supportUserBuilder().build();
      const address = siweAuthPayloadDtoBuilder().build().signer_address;
      users.isActiveWalletOwner.mockResolvedValueOnce(linked);
      await expect(repository.isWalletLinked(user.id, address)).resolves.toBe(
        linked,
      );
      expect(users.isActiveWalletOwner).toHaveBeenCalledWith(user.id, address);
      expect(users.findOneOrFail).not.toHaveBeenCalled();
    },
  );

  it('propagates database failures instead of inventing an entitlement', async () => {
    const error = new Error('Database unavailable');
    subscriptions.hasActiveSubscriptionForUser.mockRejectedValueOnce(error);
    await expect(
      repository.isEligible(supportUserBuilder().build()),
    ).rejects.toBe(error);
  });
});
