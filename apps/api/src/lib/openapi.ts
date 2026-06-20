import { OpenAPIHono } from '@hono/zod-openapi';
import type { HonoEnv } from '../bindings';
import { errorEnvelope } from './errors';

/**
 * Factory for every OpenAPIHono router in the app. Each `new OpenAPIHono()`
 * instance carries its OWN `defaultHook`; without this, sub-routers fall back to
 * zod-openapi's built-in hook and emit the raw `{ success, error }` Zod shape —
 * so validation errors looked different on every mounted router. Routing them
 * all through this factory makes request-validation failures use the SAME
 * canonical envelope (`lib/errors.ts`) as every other error in the API.
 */
export function createApiApp() {
  return new OpenAPIHono<HonoEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(
          errorEnvelope('Validation failed', {
            code: 'validation_error',
            requestId: c.var.requestId,
            fields: result.error.flatten(),
          }),
          400,
        );
      }
    },
  });
}
