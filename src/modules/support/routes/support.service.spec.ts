// SPDX-License-Identifier: FSL-1.1-MIT
import { faker } from '@faker-js/faker';
import type { MockedObject } from 'vitest';
import { FakeConfigurationService } from '@/config/__tests__/fake.configuration.service';
import { jwtClientFactory } from '@/datasources/jwt/jwt.module';
import { JwtService } from '@/datasources/jwt/jwt.service';
import {
  oidcAuthPayloadDtoBuilder,
  siweAuthPayloadDtoBuilder,
} from '@/modules/auth/domain/entities/__tests__/auth-payload-dto.entity.builder';
import { AuthPayload } from '@/modules/auth/domain/entities/auth-payload.entity';
import { supportUserBuilder } from '@/modules/support/domain/entities/__tests__/support-user.builder';
import type { ISupportRepository } from '@/modules/support/domain/support.repository.interface';
import {
  SUPPORT_TOKEN_VALIDITY_SECONDS,
  SupportService,
} from '@/modules/support/routes/support.service';

describe('SupportService', () => {
  const config = new FakeConfigurationService();
  config.set('support.pylonWalletAliasSecret', faker.string.alphanumeric(64));
  config.set('support.pylonAppId', faker.string.uuid());
  config.set('support.pylonJwtSecret', faker.string.alphanumeric(64));
  config.set('support.pylonPremiumAppId', faker.string.uuid());
  config.set('support.pylonPremiumJwtSecret', faker.string.alphanumeric(64));
  config.set('jwt.issuer', faker.internet.url());
  config.set('jwt.secret', faker.string.alphanumeric(64));
  const jwtService = new JwtService(jwtClientFactory(), config);
  const repository = {
    getUser: vi.fn(),
    isWalletLinked: vi.fn(),
    isEligible: vi.fn(),
  } as MockedObject<ISupportRepository>;
  const service = new SupportService(config, jwtService, repository);

  beforeEach(() => {
    repository.isEligible.mockResolvedValue(false);
  });

  it.each([false, true])(
    'issues verified identity for supportEligible=%s',
    async (eligible) => {
      const user = supportUserBuilder().build();
      const auth = new AuthPayload(
        oidcAuthPayloadDtoBuilder().with('sub', String(user.id)).build(),
      );
      repository.getUser.mockResolvedValue(user);
      repository.isEligible.mockResolvedValue(eligible);
      const result = await service.createSession(auth);
      const expectedAppId = config.getOrThrow<string>(
        eligible ? 'support.pylonPremiumAppId' : 'support.pylonAppId',
      );
      const expectedSecret = config.getOrThrow<string>(
        eligible ? 'support.pylonPremiumJwtSecret' : 'support.pylonJwtSecret',
      );
      const otherAppId = config.getOrThrow<string>(
        eligible ? 'support.pylonAppId' : 'support.pylonPremiumAppId',
      );
      const otherSecret = config.getOrThrow<string>(
        eligible ? 'support.pylonJwtSecret' : 'support.pylonPremiumJwtSecret',
      );
      expect(result.appId).toBe(expectedAppId);
      const claims = jwtService.verify<{
        email: string;
        name: string;
        iat: number;
        exp: number;
      }>(result.jwt, {
        audience: expectedAppId,
        secretOrPrivateKey: expectedSecret,
        algorithms: ['HS256'],
      });
      expect(() =>
        jwtService.verify(result.jwt, {
          audience: otherAppId,
          secretOrPrivateKey: expectedSecret,
          algorithms: ['HS256'],
        }),
      ).toThrow(`jwt audience invalid. expected: ${otherAppId}`);
      expect(() =>
        jwtService.verify(result.jwt, {
          audience: expectedAppId,
          secretOrPrivateKey: otherSecret,
          algorithms: ['HS256'],
        }),
      ).toThrow('invalid signature');
      expect(claims.email).toBe(user.email);
      expect(claims.name).toBe('Safe User');
      expect(claims.exp - claims.iat).toBe(SUPPORT_TOKEN_VALIDITY_SECONDS);
      expect(claims.exp).toBe(result.expiresAt);
      expect(result.supportEligible).toBe(eligible);
      expect(result.email).toBe(user.email);
      expect(repository.getUser).toHaveBeenCalledWith(user.id);
      expect(() => jwtService.verify(result.jwt)).toThrow('invalid signature');
    },
  );

  it('rejects a missing session', async () => {
    await expect(
      service.createSession(new AuthPayload()),
    ).rejects.toMatchObject({
      status: 403,
    });
    expect(repository.getUser).not.toHaveBeenCalled();
  });

  it.each(['email', 'extUserId'] as const)(
    'rejects a user without %s',
    async (field) => {
      const user = supportUserBuilder().with(field, null).build();
      repository.getUser.mockResolvedValue(user);
      await expect(
        service.createSession(
          new AuthPayload(oidcAuthPayloadDtoBuilder().build()),
        ),
      ).rejects.toMatchObject({ status: 403 });
      expect(repository.isEligible).not.toHaveBeenCalled();
    },
  );
  describe('SIWE identities', () => {
    let siweService: SupportService;
    beforeEach(() => {
      config.set(
        'support.pylonWalletAliasSecret',
        faker.string.alphanumeric(64),
      );
      siweService = new SupportService(config, jwtService, repository);
      repository.isWalletLinked.mockResolvedValue(true);
    });

    it.each([false, true])(
      'routes a wallet-only user using billing eligibility=%s',
      async (eligible) => {
        const user = supportUserBuilder()
          .with('email', null)
          .with('extUserId', null)
          .build();
        const payload = siweAuthPayloadDtoBuilder()
          .with('sub', String(user.id))
          .build();
        repository.getUser.mockResolvedValue(user);
        repository.isEligible.mockResolvedValue(eligible);
        const result = await siweService.createSession(
          new AuthPayload(payload),
        );
        expect(result).toMatchObject({
          identityType: 'wallet',
          supportEligible: eligible,
        });
        expect(result.email).toMatch(
          /^wallet-[A-Za-z0-9_-]{43}@anon\.safe\.global$/,
        );
        expect(result.email).not.toContain(
          payload.signer_address.toLowerCase(),
        );
        const claims = jwtService.verify<{
          email: string;
          name: string;
          exp: number;
          iat: number;
        }>(result.jwt, {
          audience: result.appId,
          secretOrPrivateKey: config.getOrThrow(
            eligible
              ? 'support.pylonPremiumJwtSecret'
              : 'support.pylonJwtSecret',
          ),
          algorithms: ['HS256'],
        });
        expect(claims.email).toBe(result.email);
        expect(claims.name).toBe('Safe User');
        expect(claims.exp - claims.iat).toBe(SUPPORT_TOKEN_VALIDITY_SECONDS);
        expect(repository.isWalletLinked).toHaveBeenCalledWith(
          user.id,
          payload.signer_address,
        );
      },
    );

    it('keeps aliases stable through refresh and upgrade, separate from linked email identities', async () => {
      const user = supportUserBuilder().build();
      const payload = siweAuthPayloadDtoBuilder()
        .with('sub', String(user.id))
        .build();
      repository.getUser.mockResolvedValue(user);
      const first = await siweService.createSession(new AuthPayload(payload));
      repository.isEligible.mockResolvedValue(true);
      const second = await siweService.createSession(new AuthPayload(payload));
      expect(second.email).toBe(first.email);
      expect(second.email).not.toBe(user.email);
      expect(second.appId).not.toBe(first.appId);
      const otherSigner = await siweService.createSession(
        new AuthPayload(
          siweAuthPayloadDtoBuilder().with('sub', payload.sub).build(),
        ),
      );
      expect(otherSigner.email).not.toBe(first.email);
      const otherUser = supportUserBuilder().build();
      repository.getUser.mockResolvedValue(otherUser);
      const reassigned = await siweService.createSession(
        new AuthPayload({ ...payload, sub: String(otherUser.id) }),
      );
      expect(reassigned.email).not.toBe(first.email);
    });

    it('rejects an unlinked or reassigned signer before checking eligibility', async () => {
      repository.getUser.mockResolvedValue(supportUserBuilder().build());
      repository.isWalletLinked.mockResolvedValue(false);
      await expect(
        siweService.createSession(
          new AuthPayload(siweAuthPayloadDtoBuilder().build()),
        ),
      ).rejects.toMatchObject({ status: 403 });
      expect(repository.isEligible).not.toHaveBeenCalled();
    });

    it('does not mint a token when the user or wallet lookup fails', async () => {
      repository.getUser.mockRejectedValueOnce(new Error('Inactive user'));
      await expect(
        siweService.createSession(
          new AuthPayload(siweAuthPayloadDtoBuilder().build()),
        ),
      ).rejects.toThrow('Inactive user');
      repository.getUser.mockResolvedValue(supportUserBuilder().build());
      repository.isWalletLinked.mockRejectedValueOnce(
        new Error('Database unavailable'),
      );
      await expect(
        siweService.createSession(
          new AuthPayload(siweAuthPayloadDtoBuilder().build()),
        ),
      ).rejects.toThrow('Database unavailable');
      expect(repository.isEligible).not.toHaveBeenCalled();
    });
  });
});
