// STRATEGY: this interface is the contract. Every way of sending mail (console, SMTP, an API...)
// implements it, and the code that needs to send mail only knows this interface.
export interface Mail {
  /** One recipient address. */
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  /** Resolves when the mail was handed over. Rejects (MailError) if it could not be sent. */
  send(mail: Mail): Promise<void>;
  /** Strategies that keep connections open (SMTP pool) close them here. Called on shutdown. */
  close?(): Promise<void>;
}

export class MailError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MailError';
  }
}

const SIMPLE_ADDRESS = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

// Every strategy calls this first, so all of them refuse the same bad input.
// A newline in "to" or "subject" would let an attacker add extra mail headers (header injection).
export function assertValidMail(mail: Mail): void {
  if (/[\r\n]/.test(mail.to) || /[\r\n]/.test(mail.subject)) {
    throw new MailError('Mail headers must not contain line breaks');
  }
  if (mail.to.length > 254 || !SIMPLE_ADDRESS.test(mail.to)) throw new MailError('Invalid recipient address');
  if (mail.subject.trim() === '') throw new MailError('Subject is required');
  if (mail.text.trim() === '') throw new MailError('Text body is required');
}
