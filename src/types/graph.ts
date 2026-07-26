// F7 — Teamwork Graph connector domain types.

export interface GraphConnection {
  connectionId: string;
  name: string | null;
  createdAt: string;
  updatedAt: string;
  // Root task id of the recurring reconciliation sweep, once scheduled.
  taskId: string | null;
}
