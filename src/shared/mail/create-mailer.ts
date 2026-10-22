import { ConsoleMailer } from './console-mailer.js';
import type { Mailer } from './mailer.js';
import { SmtpMailer } from './smtp-mailer.js';
import { createSmtpTransport } from './smtp-transport.js';

// Which strategy to use is decided here, from config. A new driver = a new case below.
// Nothing else in the project changes.
export type MailDriver = 'console' | 'smtp';

export interface MailConfig {
  driver: MailDriver;
  /** Required for "smtp", like smtp://user:pass@host:587 */
  smtpUrl?: string | undefined;
  /** Required for "smtp", like "Shop <no-reply@example.com>" */
  from?: string | undefined;
}

export interface CreateMailerDeps {
  log: (message: string) => void;
}

export function createMailer(config: MailConfig, deps: CreateMailerDeps): Mailer {
  switch (config.driver) {
    case 'console':
      return new ConsoleMailer(deps.log);
    case 'smtp':
      if (!config.smtpUrl || !config.from) throw new Error('The smtp mail driver needs SMTP_URL and MAIL_FROM');
      return new SmtpMailer(createSmtpTransport(config.smtpUrl), config.from);
    default: {
      const unknown: never = config.driver; // compile error if a MailDriver is added but not handled
      throw new Error(`Unknown mail driver: ${String(unknown)}`);
    }
  }
}
