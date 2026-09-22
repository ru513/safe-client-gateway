// SPDX-License-Identifier: FSL-1.1-MIT

import { faker } from '@faker-js/faker';
import cookie from '@fastify/cookie';
import { Test } from '@nestjs/testing';
import type { MockedObject } from 'vitest';
import {
  createTestApplication,
  initTestApplication,
  type TestApplication,
} from '@/__tests__/test-app.provider';
import { FakeConfigurationService } from '@/config/__tests__/fake.configuration.service';
import { IConfigurationService } from '@/config/configuration.service.interface';
import { jwtClientFactory } from '@/datasources/jwt/jwt.module';
import { JwtService } from '@/datasources/jwt/jwt.service';
import { IJwtService } from '@/datasources/jwt/jwt.service.interface';
import { IAuthRepository } from '@/modules/auth/domain/auth.repository.interface';
import {
  oidcAuthPayloadDtoBuilder,
  siweAuthPayloadDtoBuilder,
} from '@/modules/auth/domain/entities/__tests__/auth-payload-dto.entity.builder';
import { supportUserBuilder } from '@/modules/support/domain/entities/__tests__/support-user.builder';
import { ISupportRepository } from '@/modules/support/domain/support.repository.interface';
import { SupportService } from '@/modules/support/routes/support.service';
import { SupportController } from '@/modules/support/routes/v1/support.v1.controller';
import { SupportModule } from '@/modules/support/support.module';
import { CacheControlInterceptor } from '@/routes/common/interceptors/cache-control.interceptor';
import { NullResponseInterceptor } from '@/routes/common/interceptors/null-response.interceptor';

describe('Support HTTP boundary', () => {
  let app: TestApplication;
  const config = new FakeConfigurationService();
  const user = supportUserBuilder().build();
  const accessToken = faker.string.alphanumeric(32);
  const authRepository = {
    verifyToken: vi.fn(),
  } as unknown as MockedObject<IAuthRepository>;
  const repository = {
    getUser: vi.fn(),
    isWalletLinked: vi.fn(),
    isEligible: vi.fn(),
  } as MockedObject<ISupportRepository>;

  beforeAll(async () => {
    config.set('support.pylonWalletAliasSecret', faker.string.alphanumeric(64));
    config.set('support.pylonAppId', faker.string.uuid());
    config.set('support.pylonJwtSecret', faker.string.alphanumeric(64));
    config.set('support.pylonPremiumAppId', faker.string.uuid());
    config.set('support.pylonPremiumJwtSecret', faker.string.alphanumeric(64));
    config.set('jwt.issuer', faker.internet.url());
    config.set('jwt.secret', faker.string.alphanumeric(64));
    const module = await Test.createTestingModule({
      controllers: [SupportController],
      providers: [
        SupportService,
        { provide: IConfigurationService, useValue: config },
        { provide: IAuthRepository, useValue: authRepository },
        { provide: ISupportRepository, useValue: repository },
        {
          provide: IJwtService,
          useValue: new JwtService(jwtClientFactory(), config),
        },
      ],
    }).compile();
    app = createTestApplication(module);
    await app.register(cookie);
    app.useGlobalInterceptors(
      new CacheControlInterceptor(),
      new NullResponseInterceptor(),
    );
    await initTestApplication(app);
  });

  beforeEach(() => {
    authRepository.verifyToken.mockReturnValue(
      oidcAuthPayloadDtoBuilder().with('sub', String(user.id)).build(),
    );
    repository.getUser.mockResolvedValue(user);
    repository.isEligible.mockResolvedValue(false);
    repository.isWalletLinked.mockResolvedValue(true);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('rejects an anonymous session request before any user lookup', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/support/session',
    });
    expect(response.statusCode).toBe(403);
    expect(repository.getUser).not.toHaveBeenCalled();
  });

  it('rejects an invalid gateway cookie', async () => {
    authRepository.verifyToken.mockImplementationOnce(() => {
      throw new Error('Invalid signature');
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/support/session',
      cookies: { access_token: accessToken },
    });
    expect(response.statusCode).toBe(403);
    expect(repository.getUser).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'accepts verified SIWE with server-selected eligibility=%s',
    async (eligible) => {
      const payload = siweAuthPayloadDtoBuilder()
        .with('sub', String(user.id))
        .build();
      authRepository.verifyToken.mockReturnValueOnce(payload);
      repository.getUser.mockResolvedValueOnce({
        ...user,
        email: null,
        extUserId: null,
      });
      repository.isEligible.mockResolvedValueOnce(eligible);
      const response = await app.inject({
        method: 'POST',
        url: '/v1/support/session',
        cookies: { access_token: accessToken },
        payload: {
          email: faker.internet.email(),
          signerAddress: faker.finance.ethereumAddress(),
          supportEligible: !eligible,
          appId: faker.string.uuid(),
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toMatchObject({
        identityType: 'wallet',
        supportEligible: eligible,
        appId: config.getOrThrow(
          eligible ? 'support.pylonPremiumAppId' : 'support.pylonAppId',
        ),
        email: expect.stringMatching(
          /^wallet-[A-Za-z0-9_-]{43}@anon\.safe\.global$/,
        ),
      });
      expect(repository.getUser).toHaveBeenCalledWith(user.id);
      expect(repository.isWalletLinked).toHaveBeenCalledWith(
        user.id,
        payload.signer_address,
      );
    },
  );

  it('rejects a signed SIWE cookie whose wallet is no longer linked', async () => {
    authRepository.verifyToken.mockReturnValueOnce(
      siweAuthPayloadDtoBuilder().build(),
    );
    repository.isWalletLinked.mockResolvedValueOnce(false);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/support/session',
      cookies: { access_token: accessToken },
    });
    expect(response.statusCode).toBe(403);
    expect(repository.isEligible).not.toHaveBeenCalled();
  });

  it('ignores supplied identity and entitlement claims and prevents response storage', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/support/session',
      cookies: { access_token: accessToken },
      payload: {
        email: faker.internet.email(),
        supportEligible: true,
        appId: config.getOrThrow('support.pylonPremiumAppId'),
        userId: faker.number.int(),
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({
      appId: config.getOrThrow('support.pylonAppId'),
      email: user.email,
      supportEligible: false,
    });
    expect(repository.getUser).toHaveBeenCalledWith(user.id);
    expect(authRepository.verifyToken).toHaveBeenCalledWith(accessToken);
  });

  it('does not expose a separate support config endpoint', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/support/config',
    });
    expect(response.statusCode).toBe(404);
  });

  it('boots without Pylon configuration or identity dependencies and exposes no support endpoints', async () => {
    const module = await Test.createTestingModule({
      imports: [SupportModule.register(undefined)],
    }).compile();
    const disabledApp = createTestApplication(module);
    await initTestApplication(disabledApp);
    try {
      const availability = await disabledApp.inject({
        method: 'GET',
        url: '/v1/support/config',
      });
      expect(availability.statusCode).toBe(404);
      const session = await disabledApp.inject({
        method: 'POST',
        url: '/v1/support/session',
      });
      expect(session.statusCode).toBe(404);
    } finally {
      await disabledApp.close();
    }
  });
});
