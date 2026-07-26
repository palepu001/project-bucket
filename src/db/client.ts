import { applySchemaMigrations } from './schema';

// Migrations are idempotent (CREATE TABLE IF NOT EXISTS), but there is no
// reason to round-trip to Forge SQL on every single invocation once this
// container has already confirmed the schema exists. `ensureSchema` memoizes
// the in-flight/completed promise for the lifetime of the runtime container;
// the hourly scheduledTrigger (run-schema-migration in src/index.ts) is the
// only other caller and covers cold starts that race installation.
let schemaReady: Promise<void> | null = null;

// A failed migration used to be retried on the very next call — and callers
// include every repository function invoked by pollPendingSession, which the
// attachment watcher hits every 2s per open issue. A wedged migration turned
// that into a hot loop that exhausted the installation's Forge SQL quota
// (every retry re-running the same failing DDL). The cooldown makes repeated
// failures cheap (an immediate local rejection) instead of another SQL
// round-trip, without changing behaviour once migrations succeed.
const RETRY_COOLDOWN_MS = 30_000;
let retryAfter = 0;

export function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    if (Date.now() < retryAfter) {
      return Promise.reject(new Error('Schema migration failed recently; retrying after a cooldown'));
    }
    schemaReady = applySchemaMigrations().catch((error) => {
      // Let a future invocation retry instead of caching a permanent failure,
      // but not until the cooldown elapses.
      schemaReady = null;
      retryAfter = Date.now() + RETRY_COOLDOWN_MS;
      throw error;
    });
  }
  return schemaReady;
}
