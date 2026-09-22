// SPDX-License-Identifier: FSL-1.1-MIT
import type { Address } from 'viem';
import type { User } from '@/modules/users/domain/entities/user.entity';

export const ISupportRepository = Symbol('ISupportRepository');

export interface ISupportRepository {
  getUser(userId: number): Promise<User>;
  isWalletLinked(userId: number, address: Address): Promise<boolean>;
  isEligible(user: User): Promise<boolean>;
}
