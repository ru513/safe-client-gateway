// SPDX-License-Identifier: FSL-1.1-MIT
import { createHmac } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { IConfigurationService } from '@/config/configuration.service.interface';
import { IJwtService } from '@/datasources/jwt/jwt.service.interface';
import { HttpExceptionNoLog } from '@/domain/common/errors/http-exception-no-log.error';
import type { AuthPayload } from '@/modules/auth/domain/entities/auth-payload.entity';
import { ISupportRepository } from '@/modules/support/domain/support.repository.interface';
import type { SupportSessionResponse } from '@/modules/support/routes/entities/support.dto.entity';
import type { User } from '@/modules/users/domain/entities/user.entity';

export const SUPPORT_TOKEN_VALIDITY_SECONDS = 10 * 60;

@Injectable()
export class SupportService {
  private readonly walletAliasSecret: string;
  private readonly appId: string;
  private readonly jwtSecret: string;
  private readonly premiumAppId: string;
  private readonly premiumJwtSecret: string;

  constructor(
    @Inject(IConfigurationService) configuration: IConfigurationService,
    @Inject(IJwtService) private readonly jwtService: IJwtService,
    @Inject(ISupportRepository)
    private readonly supportRepository: ISupportRepository,
  ) {
    this.walletAliasSecret = configuration.getOrThrow<string>(
      'support.pylonWalletAliasSecret',
    );
    this.appId = configuration.getOrThrow<string>('support.pylonAppId');
    this.jwtSecret = configuration.getOrThrow<string>('support.pylonJwtSecret');
    this.premiumAppId = configuration.getOrThrow<string>(
      'support.pylonPremiumAppId',
    );
    this.premiumJwtSecret = configuration.getOrThrow<string>(
      'support.pylonPremiumJwtSecret',
    );
  }

  public async createSession(
    auth: AuthPayload,
  ): Promise<SupportSessionResponse> {
    if (!(auth.isAuthenticated() && (auth.isOidc() || auth.isSiwe()))) {
      throw new HttpExceptionNoLog(
        'A supported authenticated session is required',
        HttpStatus.FORBIDDEN,
      );
    }
    const user = await this.supportRepository.getUser(Number(auth.sub));
    const email = await this.getIdentityEmail(auth, user);
    const identityType = auth.isSiwe() ? 'wallet' : 'email';
    const supportEligible = await this.supportRepository.isEligible(user);
    const appId = supportEligible ? this.premiumAppId : this.appId;
    const jwtSecret = supportEligible ? this.premiumJwtSecret : this.jwtSecret;
    const issuedAt = Math.floor(Date.now() / 1_000);
    const expiresAt = issuedAt + SUPPORT_TOKEN_VALIDITY_SECONDS;
    const jwt = this.jwtService.sign(
      {
        email,
        name: 'Safe User',
        aud: appId,
        iat: new Date(issuedAt * 1_000),
        exp: new Date(expiresAt * 1_000),
      },
      { secretOrPrivateKey: jwtSecret, algorithm: 'HS256' },
    );
    // Free users also receive a verified identity for the docs/upgrade widget.
    // Pylon does not interpret arbitrary entitlement claims in identity JWTs.
    return {
      appId,
      email,
      jwt,
      expiresAt,
      supportEligible,
      identityType,
    };
  }
  private async getIdentityEmail(
    auth: AuthPayload,
    user: User,
  ): Promise<string> {
    if (auth.isSiwe()) {
      if (
        !(
          this.walletAliasSecret &&
          auth.signer_address &&
          (await this.supportRepository.isWalletLinked(
            user.id,
            auth.signer_address,
          ))
        )
      ) {
        throw new HttpExceptionNoLog(
          'Wallet identity is no longer linked',
          HttpStatus.FORBIDDEN,
        );
      }
      // Bind the alias to both the current owner and signer, independent of widget keys.
      // Base64url keeps the email local part below its 64-character limit.
      const alias = createHmac('sha256', this.walletAliasSecret)
        .update(
          JSON.stringify([
            'support-wallet-v1',
            user.id,
            auth.signer_address.toLowerCase(),
          ]),
        )
        .digest('base64url');
      return `wallet-${alias}@anon.safe.global`;
    }
    if (!(user.email && user.extUserId)) {
      throw new HttpExceptionNoLog(
        'An OIDC email identity is required',
        HttpStatus.FORBIDDEN,
      );
    }
    return user.email;
  }
}
