import { Global, Module } from '@nestjs/common';
import { AppLogger } from '../../common/logging/logger.js';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { LoggingMailer } from './logging.mailer.js';
import { MAILER, type Mailer } from './mail.port.js';
import { MailboxApiMailer } from './mailbox-api.mailer.js';
import { SmtpMailer } from './smtp.mailer.js';

@Global()
@Module({
  providers: [
    {
      provide: MAILER,
      inject: [ENV, AppLogger],
      useFactory: (env: Env, logger: AppLogger): Mailer => {
        if (env.SMTP_URL) return new SmtpMailer({ url: env.SMTP_URL, from: env.MAIL_FROM });
        if (env.MAIL_API_TOKEN) {
          return new MailboxApiMailer({
            baseUrl: env.MAIL_API_BASE_URL,
            token: env.MAIL_API_TOKEN,
            from: env.MAIL_FROM,
          });
        }
        // loadEnv refuses production without a transport, and this refuses
        // to construct there besides.
        return new LoggingMailer(logger, env.NODE_ENV);
      },
    },
  ],
  exports: [MAILER],
})
export class NotificationsModule {}
