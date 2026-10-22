import { assertValidMail, MailError, type Mail, type Mailer } from './mailer.js';

// ADAPTER: nodemailer has its own API (sendMail with its own option names). This class translates
// our Mailer contract into it. The rest of the project never imports nodemailer.
//
// SmtpTransport is the small part of nodemailer we use, so this class can be tested with a fake.
export interface SmtpMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface SmtpTransport {
  sendMail(message: SmtpMessage): Promise<unknown>;
  close(): void;
}

export class SmtpMailer implements Mailer {
  constructor(
    private readonly transport: SmtpTransport,
    private readonly from: string,
  ) {
    if (/[\r\n]/.test(from) || from.trim() === '') throw new MailError('Invalid MAIL_FROM');
  }

  async send(mail: Mail): Promise<void> {
    assertValidMail(mail);
    try {
      await this.transport.sendMail({
        from: this.from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        ...(mail.html === undefined ? {} : { html: mail.html }),
      });
    } catch (cause) {
      // The original error stays in `cause` for the log. The message is safe to show:
      // SMTP errors can contain the server address and the login.
      throw new MailError('Could not send mail', { cause });
    }
  }

  async close(): Promise<void> {
    this.transport.close();
  }
}
