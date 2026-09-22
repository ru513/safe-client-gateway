// SPDX-License-Identifier: FSL-1.1-MIT
import { Inject, Injectable } from '@nestjs/common';
import type { Address } from 'viem';
import { ISubscriptionsRepository } from '@/modules/entitlements/domain/subscriptions.repository.interface';
import type { ISupportRepository } from '@/modules/support/domain/support.repository.interface';
import type { User } from '@/modules/users/domain/entities/user.entity';
import { IUsersRepository } from '@/modules/users/domain/users.repository.interface';

@Injectable()
export class SupportRepository implements ISupportRepository {
  constructor(
    @Inject(IUsersRepository)
    private readonly usersRepository: IUsersRepository,
    @Inject(ISubscriptionsRepository)
    private readonly subscriptionsRepository: ISubscriptionsRepository,
  ) {}

  public getUser(userId: number): Promise<User> {
    return this.usersRepository.findOneOrFail({ id: userId, status: 'ACTIVE' });
  }

  public isWalletLinked(userId: number, address: Address): Promise<boolean> {
    return this.usersRepository.isActiveWalletOwner(userId, address);
  }

  public isEligible(user: User): Promise<boolean> {
    // EXISTS checks current membership/subscription state without hydrating relations.
    return this.subscriptionsRepository.hasActiveSubscriptionForUser(user.id);
  }
}
