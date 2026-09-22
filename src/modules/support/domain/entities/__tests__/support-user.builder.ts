// SPDX-License-Identifier: FSL-1.1-MIT
import { faker } from '@faker-js/faker';
import { getAddress } from 'viem';
import { Builder, type IBuilder } from '@/__tests__/builder';
import { spaceBuilder } from '@/modules/spaces/domain/entities/__tests__/space.entity.db.builder';
import type { SpaceSafe } from '@/modules/spaces/domain/safes/entities/space-safe.entity';
import { memberBuilder } from '@/modules/users/datasources/entities/__tests__/member.entity.db.builder';
import { userBuilder } from '@/modules/users/datasources/entities/__tests__/users.entity.db.builder';
import type { User } from '@/modules/users/domain/entities/user.entity';
import { EmailAddressSchema } from '@/validation/entities/schemas/email-address.schema';

export function supportUserBuilder(): IBuilder<User> {
  const safe = new Builder<SpaceSafe>()
    .with('id', faker.number.int({ min: 1 }))
    .with('createdAt', faker.date.past())
    .with('updatedAt', faker.date.recent())
    .with('chainId', faker.string.numeric({ length: 3 }))
    .with('address', getAddress(faker.finance.ethereumAddress()))
    .build();
  const space = spaceBuilder().with('safes', [safe]).build();
  return userBuilder()
    .with('status', 'ACTIVE')
    .with('email', EmailAddressSchema.parse(faker.internet.email()))
    .with('extUserId', faker.string.uuid())
    .with('members', [memberBuilder().with('space', space).build()]);
}
