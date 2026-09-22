// SPDX-License-Identifier: FSL-1.1-MIT
import { type DynamicModule, Module } from '@nestjs/common';
import { JwtModule } from '@/datasources/jwt/jwt.module';
import { AuthRepositoryModule } from '@/modules/auth/domain/auth-repository.module';
import { EntitlementsRepositoryModule } from '@/modules/entitlements/domain/entitlements-repository.module';
import { SupportRepository } from '@/modules/support/domain/support.repository';
import { ISupportRepository } from '@/modules/support/domain/support.repository.interface';
import { SupportService } from '@/modules/support/routes/support.service';
import { SupportController } from '@/modules/support/routes/v1/support.v1.controller';
import { UsersRepositoryModule } from '@/modules/users/domain/users-repository.module';

@Module({})
export class SupportModule {
  public static register(pylonAppId: string | undefined): DynamicModule {
    const configured = Boolean(pylonAppId?.trim());
    return {
      module: SupportModule,
      imports: configured
        ? [
            AuthRepositoryModule,
            UsersRepositoryModule,
            EntitlementsRepositoryModule,
            JwtModule,
          ]
        : [],
      controllers: configured ? [SupportController] : [],
      providers: configured
        ? [
            { provide: ISupportRepository, useClass: SupportRepository },
            SupportService,
          ]
        : [],
    };
  }
}
