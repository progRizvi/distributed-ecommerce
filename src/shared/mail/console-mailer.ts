import { assertValidMail, type Mail, type Mailer } from './mailer.js';

// Strategy for development: nothing leaves the machine, the mail is printed to the log.
export class ConsoleMailer implements Mailer {
  constructor(private readonly log: (message: string) => void = console.log) {}

  async send(mail: Mail): Promise<void> {
    assertValidMail(mail);
    this.log(`[mail] to=${mail.to} subject="${mail.subject}"\n${mail.text}`);
  }
}
