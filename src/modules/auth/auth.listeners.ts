import type { EventBus } from '../../shared/events/event-bus.js';
import type { Mailer } from '../../shared/mail/mailer.js';
import { welcomeMail } from './auth.mails.js';

// This is the "context" of the Strategy pattern: it uses a Mailer and does not care which one.
// If sending fails, the event bus reports it. The user's registration is not affected.
export function registerAuthListeners(events: EventBus, mailer: Mailer): void {
  events.on('user.registered', async ({ email }) => {
    await mailer.send(welcomeMail(email));
  });
}
