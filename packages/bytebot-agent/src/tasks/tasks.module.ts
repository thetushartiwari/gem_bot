import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { TasksGateway } from './tasks.gateway';
import { PrismaModule } from '../prisma/prisma.module';
import { MessagesModule } from '../messages/messages.module';
import { TaskSecretsService } from './task-secrets.service';
import { BrowserSessionsService } from './browser-sessions.service';
import { BrowserSessionCryptoService } from './browser-session-crypto.service';
import { MediaSessionService } from './media-session.service';

@Module({
  imports: [ConfigModule, PrismaModule, MessagesModule],
  controllers: [TasksController],
  providers: [
    TasksService,
    TasksGateway,
    TaskSecretsService,
    BrowserSessionsService,
    BrowserSessionCryptoService,
    MediaSessionService,
  ],
  exports: [
    TasksService,
    TasksGateway,
    TaskSecretsService,
    BrowserSessionsService,
    BrowserSessionCryptoService,
    MediaSessionService,
  ],
})
export class TasksModule {}
