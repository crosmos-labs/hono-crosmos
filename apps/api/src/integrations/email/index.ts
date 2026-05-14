import type { Env } from '../../bindings';
import { NoopEmailSender } from './noop';
import type { EmailSender } from './port';
import { ResendEmailSender } from './resend';

export type { EmailSender } from './port';

/**
 * Returns the configured email sender for this environment. Features should
 * always go through this factory — never instantiate `ResendEmailSender`
 * directly. Switch provider = change this file.
 */
export function getEmailSender(env: Env): EmailSender {
  if (env.RESEND_API_KEY) {
    return new ResendEmailSender(env.RESEND_API_KEY);
  }
  return new NoopEmailSender();
}
