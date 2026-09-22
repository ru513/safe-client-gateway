// SPDX-License-Identifier: FSL-1.1-MIT
import { ApiProperty } from '@nestjs/swagger';

export class SupportSessionResponse {
  @ApiProperty({ description: 'Pylon Chat Widget App ID.' })
  appId!: string;

  @ApiProperty({
    enum: ['email', 'wallet'],
    description: 'Descriptive identity type, not authorization.',
  })
  identityType!: 'email' | 'wallet';

  @ApiProperty({
    description:
      'Authenticated email or server-derived, non-deliverable wallet alias.',
  })
  email!: string;

  @ApiProperty({
    description: 'Pylon identity JWT. Never persist or log this value.',
  })
  jwt!: string;

  @ApiProperty({ description: 'JWT expiration as Unix seconds.' })
  expiresAt!: number;

  @ApiProperty({
    description:
      'Server-computed eligibility used to select the help-only or premium Pylon widget; not messaging authorization.',
  })
  supportEligible!: boolean;
}
