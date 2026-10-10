export interface MailAttachment {
  filename: string;
  content: string;
  contentType: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string | undefined;
  attachments?: MailAttachment[] | undefined;
}

export interface Mailer {
  readonly name: string;
  send(message: MailMessage): Promise<void>;
}

export const MAILER = Symbol('MAILER');
