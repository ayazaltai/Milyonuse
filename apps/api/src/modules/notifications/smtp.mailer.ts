import { createTransport, type Transporter } from 'nodemailer';
import type { Mailer, MailMessage } from './mail.port.js';

export interface SmtpConfig {
  url: string;
  from: string;
}

export class SmtpMailer implements Mailer {
  readonly name = 'smtp';
  private readonly transport: Transporter;

  constructor(private readonly config: SmtpConfig) {
    this.transport = createTransport(config.url);
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.config.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
      ...(message.attachments
        ? {
            attachments: message.attachments.map((a) => ({
              filename: a.filename,
              content: a.content,
              contentType: a.contentType,
            })),
          }
        : {}),
    });
  }
}
