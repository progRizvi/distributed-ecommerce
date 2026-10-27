import { assertValidMail, type Mailer } from '../shared/mail/mailer.js';
import { PermanentJobError, type JobHandlers } from './queue.js';

export interface JobHandlerDeps {
  mailer: Mailer;
}

// One function per job type. They know nothing about BullMQ or Redis.
export function createJobHandlers({ mailer }: JobHandlerDeps): JobHandlers {
  return {
    'send-mail': async (mail) => {
      // A broken mail will be broken on every retry, so do not retry it.
      try {
        assertValidMail(mail);
      } catch (cause) {
        throw new PermanentJobError('Invalid mail, not retrying', { cause });
      }
      // Anything thrown here (SMTP down...) is temporary: the job is retried.
      await mailer.send(mail);
    },
  };
}
