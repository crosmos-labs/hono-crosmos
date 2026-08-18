import { z } from 'zod';

export const grantBody = z.object({
  plan: z.enum(['free', 'developer', 'pro', 'enterprise']),
  expires_at: z.string().datetime(),
});
