// SPDX-License-Identifier: FSL-1.1-MIT
import {
  Controller,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import type { AuthPayload } from '@/modules/auth/domain/entities/auth-payload.entity';
import { AuthGuard } from '@/modules/auth/routes/guards/auth.guard';
import { SupportSessionResponse } from '@/modules/support/routes/entities/support.dto.entity';
import { SupportService } from '@/modules/support/routes/support.service';
import { Auth } from '@/routes/common/auth/auth.decorator';

@ApiTags('support')
@Controller({ path: 'support', version: '1' })
export class SupportController {
  constructor(private readonly supportService: SupportService) {}

  @Post('session')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'Create a Pylon identity from the current OIDC or SIWE session.',
    description:
      'Requires an authenticated gateway session. SIWE requires the verified signer to remain linked to the active user. OIDC uses the stored verified email; SIWE uses a server-derived wallet alias. Workspace subscription eligibility determines the selected widget.',
  })
  @ApiOkResponse({ type: SupportSessionResponse })
  @ApiForbiddenResponse({
    description:
      'Missing or invalid gateway session, an unlinked SIWE signer, or a missing OIDC email identity.',
  })
  @ApiNotFoundResponse({
    description: 'The active gateway user was not found.',
  })
  public async createSession(
    @Auth() auth: AuthPayload,
    @Res() reply: FastifyReply,
  ): Promise<FastifyReply> {
    const session = await this.supportService.createSession(auth);
    // Send before the global cache interceptor can overwrite the no-store header.
    return reply.send(session);
  }
}
