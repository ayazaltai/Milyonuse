import { AppLogger } from '../../common/logging/logger.js';
import type { Mailer, MailMessage } from './mail.port.js';

/**
 * Writes mail to the log instead of sending it.
 *
 * Used when no transport is configured, so a fresh checkout can register and
 * reset a password without a mail server. It logs the subject but never the
 * body: an account mail carries a link that opens an account, and logs are the
 * wrong place for that. The API hands the link back in its answer instead,
 * while this mailer is the one in use (AccountService.development). The logger
 * masks the recipient.
 */
export class LoggingMailer implements Mailer {
  readonly name = 'logging';

  constructor(
    private readonly logger: AppLogger,
    nodeEnv: string,
  ) {
    if (nodeEnv === 'production') {
      throw new Error('LoggingMailer must never run in production. Configure SMTP_URL or MAIL_API_TOKEN.');
    }
  }

  async send(message: MailMessage): Promise<void> {
    this.logger.log('mail not sent (no transport configured)', {
      to: message.to,
      subject: message.subject,
      attachments: message.attachments?.map((a) => a.filename) ?? [],
    });
    return Promise.resolve();
  }
}
