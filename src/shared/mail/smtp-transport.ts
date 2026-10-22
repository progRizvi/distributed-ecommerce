import { createTransport } from 'nodemailer';
import type { SmtpTransport } from './smtp-mailer.js';

// The only place that touches nodemailer. `url` looks like smtp://user:pass@host:587
//   smtps://  = TLS from the first byte (usually port 465)
//   ?requireTLS=true = refuse to send if the server cannot upgrade to TLS (use this in production)
export function createSmtpTransport(url: string): SmtpTransport {
  const parsed = new URL(url);
  if (parsed.protocol !== 'smtp:' && parsed.protocol !== 'smtps:') throw new Error('SMTP_URL must start with smtp:// or smtps://');

  const secure = parsed.protocol === 'smtps:';
  return createTransport({
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : secure ? 465 : 587,
    secure,
    requireTLS: parsed.searchParams.get('requireTLS') === 'true',
    ...(parsed.username
      ? { auth: { user: decodeURIComponent(parsed.username), pass: decodeURIComponent(parsed.password) } }
      : {}),
    pool: true, // reuse connections, do not reconnect for every mail
    maxConnections: 5,
    // Never wait forever on the mail server (it must not hang a request or a shutdown).
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    socketTimeout: 15_000,
  });
}
