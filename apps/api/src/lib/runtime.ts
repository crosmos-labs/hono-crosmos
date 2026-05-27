import { createBackgroundTasks, type BackgroundTasks } from '@crosmos/runtime';
import type { LogFields, Logger } from '@crosmos/observability';

export interface WaitUntilContext {
  executionCtx: {
    waitUntil(task: Promise<unknown>): void;
  };
}

export function getBackgroundTasks(c: WaitUntilContext): BackgroundTasks {
  return createBackgroundTasks((task) => c.executionCtx.waitUntil(task));
}

export function waitUntilLogged(
  c: WaitUntilContext,
  logger: Logger,
  event: string,
  task: Promise<unknown>,
  fields: LogFields = {},
): void {
  getBackgroundTasks(c).waitUntil(
    task.catch((err) => logger.warn(event, fields, err)),
  );
}
