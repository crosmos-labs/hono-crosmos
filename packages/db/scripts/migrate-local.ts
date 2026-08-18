const rawUrl = process.env.DATABASE_URL;
if (!rawUrl) {
  throw new Error('DATABASE_URL is required for local migrations');
}

const url = new URL(rawUrl);
const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
if (!localHosts.has(url.hostname)) {
  throw new Error(
    `Refusing drizzle-kit migrate against non-local host ${url.hostname}; apply reviewed production SQL explicitly`,
  );
}

const child = Bun.spawn(['bunx', 'drizzle-kit', 'migrate'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: process.env,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});
process.exit(await child.exited);
