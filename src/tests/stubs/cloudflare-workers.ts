/**
 * Stand-in for the `cloudflare:workers` runtime module, which only exists inside
 * workerd. The OAuth provider imports WorkerEntrypoint from it; the tests never
 * use that class, but the import has to resolve under Node.
 */
export class WorkerEntrypoint {
  constructor(
    public ctx?: unknown,
    public env?: unknown,
  ) {}
}
