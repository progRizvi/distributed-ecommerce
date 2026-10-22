import { afterEach, describe, expect, it } from 'vitest';
import { MailError } from '../../src/shared/mail/mailer.js';
import { SmtpMailer } from '../../src/shared/mail/smtp-mailer.js';
import { createSmtpTransport } from '../../src/shared/mail/smtp-transport.js';
import { startFakeSmtpServer } from '../helpers/fake-smtp-server.js';

// Real nodemailer, real SMTP conversation over a local socket. No Docker, no internet.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function setup() {
  const server = await startFakeSmtpServer();
  const mailer = new SmtpMailer(createSmtpTransport(`smtp://127.0.0.1:${server.port}`), 'Shop <no-reply@shop.test>');
  cleanups.push(() => server.close());
  cleanups.push(() => mailer.close());
  return { server, mailer };
}

describe('SmtpMailer with the real nodemailer transport', () => {
  it('delivers a mail: envelope, headers and body arrive at the server', async () => {
    const { server, mailer } = await setup();

    await mailer.send({ to: 'a@x.com', subject: 'Welcome', text: 'Happy shopping' });

    expect(server.received).toHaveLength(1);
    const got = server.received[0]!;
    expect(got.from).toContain('no-reply@shop.test');
    expect(got.to.join()).toContain('a@x.com');
    expect(got.data).toContain('Subject: Welcome');
    expect(got.data).toContain('Happy shopping');
    expect(got.data).toMatch(/From: .*no-reply@shop\.test/);
  });

  it('reuses the connection pool for several mails', async () => {
    const { server, mailer } = await setup();
    for (let i = 0; i < 3; i += 1) await mailer.send({ to: `u${i}@x.com`, subject: `Mail ${i}`, text: 'Body' });
    expect(server.received).toHaveLength(3);
  });

  it('a header injection attempt never reaches the server', async () => {
    const { server, mailer } = await setup();
    await expect(mailer.send({ to: 'a@x.com', subject: 'Hi\r\nBcc: victim@x.com', text: 'Body' })).rejects.toBeInstanceOf(MailError);
    expect(server.received).toEqual([]);
  });

  it('when the mail server is not reachable, send() rejects with a MailError (and does not hang)', async () => {
    const server = await startFakeSmtpServer();
    const port = server.port;
    await server.close(); // nobody listens on this port any more
    const mailer = new SmtpMailer(createSmtpTransport(`smtp://127.0.0.1:${port}`), 'Shop <no-reply@shop.test>');
    cleanups.push(() => mailer.close());

    await expect(mailer.send({ to: 'a@x.com', subject: 'Hi', text: 'Body' })).rejects.toBeInstanceOf(MailError);
  });
});

describe('createSmtpTransport', () => {
  it('refuses a URL that is not smtp:// or smtps://', () => {
    expect(() => createSmtpTransport('http://example.com')).toThrow(/smtp/);
  });
});
