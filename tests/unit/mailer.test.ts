import { describe, expect, it } from 'vitest';
import { ConsoleMailer } from '../../src/shared/mail/console-mailer.js';
import { createMailer } from '../../src/shared/mail/create-mailer.js';
import { assertValidMail, MailError, type Mail, type Mailer } from '../../src/shared/mail/mailer.js';
import { SmtpMailer } from '../../src/shared/mail/smtp-mailer.js';
import { FakeMailer, FakeSmtpTransport } from '../helpers/fakes.js';

const good: Mail = { to: 'a@x.com', subject: 'Hello', text: 'Body' };

describe('assertValidMail', () => {
  it('accepts a normal mail', () => {
    expect(() => assertValidMail(good)).not.toThrow();
  });

  it('refuses line breaks in to or subject (header injection)', () => {
    expect(() => assertValidMail({ ...good, subject: 'Hi\r\nBcc: victim@x.com' })).toThrow(MailError);
    expect(() => assertValidMail({ ...good, to: 'a@x.com\nBcc: victim@x.com' })).toThrow(MailError);
  });

  it('refuses bad addresses, several recipients, empty subject and empty body', () => {
    for (const to of ['nope', 'a@x', 'a@x.com, b@x.com', 'A <a@x.com>', '', `${'a'.repeat(250)}@x.com`]) {
      expect(() => assertValidMail({ ...good, to })).toThrow(MailError);
    }
    expect(() => assertValidMail({ ...good, subject: '  ' })).toThrow(MailError);
    expect(() => assertValidMail({ ...good, text: '' })).toThrow(MailError);
  });
});

// The Strategy promise: every strategy behaves the same through the Mailer interface.
// Add a new strategy (SMTP, Resend...) to this list and it must pass the same tests.
const strategies: [string, () => Mailer][] = [
  ['ConsoleMailer', () => new ConsoleMailer(() => {})],
  ['FakeMailer', () => new FakeMailer()],
  ['SmtpMailer', () => new SmtpMailer(new FakeSmtpTransport(), 'Shop <no-reply@shop.test>')],
];

describe.each(strategies)('Mailer contract: %s', (_name, make) => {
  it('sends a valid mail without error', async () => {
    await expect(make().send(good)).resolves.toBeUndefined();
  });

  it('rejects an invalid mail with MailError', async () => {
    await expect(make().send({ ...good, to: 'nope' })).rejects.toBeInstanceOf(MailError);
    await expect(make().send({ ...good, subject: 'x\r\nBcc: y@x.com' })).rejects.toBeInstanceOf(MailError);
  });
});

describe('ConsoleMailer', () => {
  it('prints to, subject and body, and sends nothing anywhere else', async () => {
    const lines: string[] = [];
    await new ConsoleMailer((m) => lines.push(m)).send(good);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('to=a@x.com');
    expect(lines[0]).toContain('Hello');
    expect(lines[0]).toContain('Body');
  });

  it('prints nothing for an invalid mail', async () => {
    const lines: string[] = [];
    await new ConsoleMailer((m) => lines.push(m)).send({ ...good, to: 'nope' }).catch(() => {});
    expect(lines).toEqual([]);
  });
});

describe('createMailer (picks the strategy from config)', () => {
  it('"console" gives a ConsoleMailer', () => {
    expect(createMailer({ driver: 'console' }, { log: () => {} })).toBeInstanceOf(ConsoleMailer);
  });

  it('"smtp" gives an SmtpMailer, and needs SMTP_URL and MAIL_FROM', async () => {
    const mailer = createMailer({ driver: 'smtp', smtpUrl: 'smtp://localhost:1025', from: 'Shop <no-reply@x.com>' }, { log: () => {} });
    expect(mailer).toBeInstanceOf(SmtpMailer);
    await mailer.close?.();

    expect(() => createMailer({ driver: 'smtp', from: 'a@x.com' }, { log: () => {} })).toThrow(/SMTP_URL/);
    expect(() => createMailer({ driver: 'smtp', smtpUrl: 'smtp://localhost:1025' }, { log: () => {} })).toThrow(/MAIL_FROM/);
  });

  it('an unknown driver fails loudly instead of silently sending nothing', () => {
    expect(() => createMailer({ driver: 'carrier-pigeon' as never }, { log: () => {} })).toThrow(/Unknown mail driver/);
  });
});
