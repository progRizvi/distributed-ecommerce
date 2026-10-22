import { describe, expect, it } from 'vitest';
import { MailError } from '../../src/shared/mail/mailer.js';
import { SmtpMailer } from '../../src/shared/mail/smtp-mailer.js';
import { FakeSmtpTransport } from '../helpers/fakes.js';

const FROM = 'Shop <no-reply@shop.test>';
const mail = { to: 'a@x.com', subject: 'Hello', text: 'Body' };

describe('SmtpMailer (adapter)', () => {
  it('translates our Mail into the transport message and adds the From address', async () => {
    const transport = new FakeSmtpTransport();
    await new SmtpMailer(transport, FROM).send({ ...mail, html: '<p>Body</p>' });
    expect(transport.sent).toEqual([{ from: FROM, to: 'a@x.com', subject: 'Hello', text: 'Body', html: '<p>Body</p>' }]);
  });

  it('leaves html out when there is none', async () => {
    const transport = new FakeSmtpTransport();
    await new SmtpMailer(transport, FROM).send(mail);
    expect(transport.sent[0]).not.toHaveProperty('html');
  });

  it('validates first: an invalid mail never reaches the transport', async () => {
    const transport = new FakeSmtpTransport();
    const mailer = new SmtpMailer(transport, FROM);
    await expect(mailer.send({ ...mail, subject: 'Hi\r\nBcc: victim@x.com' })).rejects.toBeInstanceOf(MailError);
    await expect(mailer.send({ ...mail, to: 'nope' })).rejects.toBeInstanceOf(MailError);
    expect(transport.sent).toEqual([]);
  });

  it('wraps transport errors in a MailError that does not leak server details, but keeps the cause', async () => {
    const transport = new FakeSmtpTransport();
    const original = new Error('connect ECONNREFUSED 10.0.0.9:587 login=user:s3cret');
    transport.error = original;

    const error = await new SmtpMailer(transport, FROM).send(mail).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MailError);
    expect((error as MailError).message).toBe('Could not send mail');
    expect((error as MailError).message).not.toContain('s3cret');
    expect((error as MailError).cause).toBe(original);
  });

  it('refuses a From address with a line break or an empty one', () => {
    expect(() => new SmtpMailer(new FakeSmtpTransport(), 'a@x.com\r\nBcc: y@x.com')).toThrow(MailError);
    expect(() => new SmtpMailer(new FakeSmtpTransport(), '  ')).toThrow(MailError);
  });

  it('close() closes the transport (SMTP connections)', async () => {
    const transport = new FakeSmtpTransport();
    await new SmtpMailer(transport, FROM).close();
    expect(transport.closed).toBe(true);
  });
});
