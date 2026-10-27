import type { JobQueue } from '../../jobs/queue.js';
import type { EventBus } from '../../shared/events/event-bus.js';
import { welcomeMail } from './auth.mails.js';

// Reacts to events by putting jobs in the queue. The mail itself is sent later by the worker process,
// with retries, so a slow or broken mail server never slows down or breaks registration.
// If even the queue is down, the event bus reports the error and registration still succeeds.
export function registerAuthListeners(events: EventBus, queue: JobQueue): void {
  events.on('user.registered', async ({ userId, email }) => {
    // Same jobId = one welcome mail per user, even if the event is delivered twice.
    await queue.enqueue('send-mail', welcomeMail(email), { jobId: `welcome-${userId}` });
  });
}
