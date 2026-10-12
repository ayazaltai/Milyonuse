export * from './types.js';
export {
  CODE_ALPHABET,
  CODE_LENGTH,
  type ActionVerb,
  chunks,
  codeDigest,
  codeIn,
  commandOf,
  decodeAction,
  encodeAction,
  generateCode,
} from './common.js';
export { TelegramAdapter, type TelegramConfig } from './telegram.js';
export { WhatsAppAdapter, type WhatsAppConfig } from './whatsapp.js';
export { SlackAdapter, type SlackConfig } from './slack.js';
export { DiscordAdapter, type DiscordConfig } from './discord.js';
export { EmailAdapter, type EmailConfig, addressOf } from './email.js';
