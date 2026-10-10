import { ACCOUNT_LINK_HOURS, type Locale } from '@milyonuse/contracts';
import type { MailMessage } from '../notifications/mail.port.js';

/**
 * The mail an account sends, in the person's language.
 *
 * Plain text on purpose: it renders the same in every client, cannot carry a
 * tracking pixel, and a link in it is exactly what it looks like.
 */

const SIGN_OFF: Record<Locale, string> = {
  en: '\n\n— Milyonuse',
  tr: '\n\n— Milyonuse',
};

export function verifyMail(locale: Locale, to: string, name: string, link: string): MailMessage {
  const hours = ACCOUNT_LINK_HOURS.verifyEmail;
  return locale === 'tr'
    ? {
        to,
        subject: 'Milyonuse e-posta adresini doğrula',
        text:
          `Merhaba ${name},\n\n` +
          `Milyonuse hesabını açmayı tamamlamak için bu adresi doğrula:\n${link}\n\n` +
          `Bağlantı bir kez çalışır ve ${hours} saat sonra geçersiz olur. Kayıt olan sen değilsen bu ` +
          `mesajı yok sayabilirsin — bağlantı açılmadıkça hiçbir şey oluşturulmaz.` +
          SIGN_OFF.tr,
      }
    : {
        to,
        subject: 'Confirm your email for Milyonuse',
        text:
          `Hi ${name},\n\n` +
          `Confirm this address to finish opening your Milyonuse account:\n${link}\n\n` +
          `The link works once and expires in ${hours} hours. If you did not register, ignore this ` +
          `message — nothing is created until the link is followed.` +
          SIGN_OFF.en,
      };
}

export function alreadyRegisteredMail(locale: Locale, to: string, signIn: string, reset: string): MailMessage {
  return locale === 'tr'
    ? {
        to,
        subject: 'Zaten bir Milyonuse hesabın var',
        text:
          `Biri bu adresle yeni bir Milyonuse hesabı açmayı denedi, ama bu adresin zaten bir hesabı var.\n\n` +
          `Giriş yap: ${signIn}\n` +
          `Şifreni mi unuttun? Yenisini belirle: ${reset}\n\n` +
          `Bu sen değilsen mesajı yok sayabilirsin; hesabında bir şey değişmedi.` +
          SIGN_OFF.tr,
      }
    : {
        to,
        subject: 'You already have a Milyonuse account',
        text:
          `Someone tried to register a new Milyonuse account with this address, which already has one.\n\n` +
          `Sign in: ${signIn}\n` +
          `Forgotten your password? Set a new one: ${reset}\n\n` +
          `If this was not you, you can ignore this message; your account has not changed.` +
          SIGN_OFF.en,
      };
}

export function passwordLinkMail(locale: Locale, to: string, link: string): MailMessage {
  const hours = ACCOUNT_LINK_HOURS.setPassword;
  return locale === 'tr'
    ? {
        to,
        subject: 'Milyonuse şifreni belirle',
        text:
          `Milyonuse hesabın için yeni bir şifre belirlemek üzere bu bağlantıyı kullan:\n${link}\n\n` +
          `Bağlantı bir kez çalışır ve ${hours} saat sonra geçersiz olur. Bunu sen istemediysen mesajı ` +
          `yok say — şifren değişmedi.` +
          SIGN_OFF.tr,
      }
    : {
        to,
        subject: 'Set your Milyonuse password',
        text:
          `Use this link to set a new password for your Milyonuse account:\n${link}\n\n` +
          `It works once and expires in ${hours} hour. If you did not ask for it, ignore this ` +
          `message — your password has not changed.` +
          SIGN_OFF.en,
      };
}

export function noAccountMail(locale: Locale, to: string, register: string): MailMessage {
  return locale === 'tr'
    ? {
        to,
        subject: 'Bu adres için Milyonuse hesabı yok',
        text:
          `Biri bu adresle bir Milyonuse hesabının şifresini sıfırlamak istedi, ama bu adresin hesabı yok.\n\n` +
          `Hesap açmak için: ${register}\n\n` +
          `Bu sen değilsen mesajı yok sayabilirsin.` +
          SIGN_OFF.tr,
      }
    : {
        to,
        subject: 'No Milyonuse account for this address',
        text:
          `Someone asked to reset the password of a Milyonuse account with this address, but there is ` +
          `no account for it.\n\nTo open one: ${register}\n\n` +
          `If this was not you, ignore this message.` +
          SIGN_OFF.en,
      };
}

export function passwordChangedMail(locale: Locale, to: string, reset: string): MailMessage {
  return locale === 'tr'
    ? {
        to,
        subject: 'Milyonuse şifren değişti',
        text:
          `Milyonuse hesabının şifresi az önce değişti ve diğer tüm oturumları kapatıldı.\n\n` +
          `Bu sen değilsen hemen yeni bir şifre belirle: ${reset}` +
          SIGN_OFF.tr,
      }
    : {
        to,
        subject: 'Your Milyonuse password was changed',
        text:
          `The password for your Milyonuse account was just changed, and every other session it had ` +
          `was signed out.\n\nIf this was not you, set a new password now: ${reset}` +
          SIGN_OFF.en,
      };
}
