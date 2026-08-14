export class AdminRateLimiterDO implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}
  async fetch(request: Request): Promise<Response> {
    const { limit } = await request.json<{ limit: number }>();
    const now = Date.now();
    const window = Math.floor(now / 60_000);
    const stored = await this.state.storage.get<{ window: number; count: number }>('minute');
    const next = stored?.window === window ? stored.count + 1 : 1;
    await this.state.storage.put('minute', { window, count: next });
    return Response.json({ allowed: next <= limit, count: next });
  }
}
