/**
 * The hard multi-tenant isolation guard (docs/02-architecture.md).
 *
 * Isolation is a property of the data-access layer, not a filter callers must remember to add:
 * there is NO unscoped query builder. Every tenant-scoped read flows through `tenantScopedSelect`,
 * which makes `tenant_id = ?` the first predicate and refuses to run without a tenant.
 */

export class TenantIsolationError extends Error {
  constructor(message = 'a tenant scope is required to access tenant-scoped data') {
    super(message);
    this.name = 'TenantIsolationError';
  }
}

/** Narrow `tenantId` to a non-empty string or throw. */
export function assertTenantId(tenantId: unknown): asserts tenantId is string {
  if (typeof tenantId !== 'string' || tenantId.trim() === '') {
    throw new TenantIsolationError('a non-empty tenantId is required');
  }
}

export interface ScopedQuery {
  sql: string;
  params: unknown[];
}

/** Tables that MUST be queried within a tenant scope. Users are global (scoped via memberships). */
export const TENANT_SCOPED_TABLES = new Set<string>([
  'memberships',
  'boards',
  'agents',
  'agent_tokens',
]);

export interface ScopedSelectOptions {
  columns?: string[];
  where?: Record<string, unknown>;
}

/**
 * Build a SELECT that is structurally incapable of crossing tenants. `tenant_id = ?` is always the
 * first predicate (bound first); the table must be registered as tenant-scoped.
 */
export function tenantScopedSelect(
  table: string,
  tenantId: string,
  options: ScopedSelectOptions = {},
): ScopedQuery {
  assertTenantId(tenantId);
  if (!TENANT_SCOPED_TABLES.has(table)) {
    throw new TenantIsolationError(`table "${table}" is not registered as tenant-scoped`);
  }
  const columns =
    options.columns && options.columns.length > 0 ? options.columns.join(', ') : '*';
  const predicates = ['tenant_id = ?'];
  const params: unknown[] = [tenantId];
  for (const [key, value] of Object.entries(options.where ?? {})) {
    predicates.push(`${key} = ?`);
    params.push(value);
  }
  return { sql: `SELECT ${columns} FROM ${table} WHERE ${predicates.join(' AND ')}`, params };
}
