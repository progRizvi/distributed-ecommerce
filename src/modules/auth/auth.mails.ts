import type { Mail } from '../../shared/mail/mailer.js';

// Plain functions that build the content. They know nothing about HOW mail is sent.
export function welcomeMail(email: string): Mail {
  return {
    to: email,
    subject: 'Welcome to our shop',
    text: 'Your account has been created. Happy shopping!',
  };
}
