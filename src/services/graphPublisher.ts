import { graph, types } from '@forge/teamwork-graph';
import { getActiveConnection } from '../repositories/graphConnectionRepository';

// Outcome of a publish attempt, distilled from the SDK's BulkObjectResponse so
// every caller (the M4 webtrigger test today, event-driven publishing in M6)
// reads one shape. `published` is true only when the graph accepted every
// object with no rejections.
export interface PublishResult {
  published: boolean;
  accepted: number;
  rejected: types.RejectedObject[];
  // Set when publishing was not even attempted because the admin has not
  // connected the Teamwork Graph connector yet. This is a skip, not a failure.
  skippedReason?: 'NO_CONNECTION';
  error?: string;
}

// Publishes atlassian:document metadata objects into Teamwork Graph through the
// active connection. If no connection exists there is nothing to publish
// through, so we skip rather than error: the next lifecycle event (or the
// reconciliation sweep) republishes once an admin connects.
export async function publishDocuments(
  objects: types.DocumentObject[]
): Promise<PublishResult> {
  if (objects.length === 0) {
    return { published: true, accepted: 0, rejected: [] };
  }

  const connection = await getActiveConnection();
  if (!connection) {
    ((..._args: any[]) => {})('[ProjectBucket] Skipping graph publish: no active Teamwork Graph connection');
    return { published: false, accepted: 0, rejected: [], skippedReason: 'NO_CONNECTION' };
  }

  const response = await graph.setObjects({
    connectionId: connection.connectionId,
    objects,
  });

  // The server reports synchronously-validated-and-queued objects under
  // `validObjects`; `accepted` appears in other response variants. Count
  // either as acceptance — rejection is what's reported explicitly.
  const accepted = response.results?.accepted ?? response.results?.validObjects ?? [];
  const rejected = response.results?.rejected ?? [];

  if (!response.success || rejected.length > 0) {
    console.error(
      '[ProjectBucket] Teamwork Graph rejected objects:',
      JSON.stringify({ error: response.error, rejected })
    );
  } else {
    ((..._args: any[]) => {})(`[ProjectBucket] Published ${accepted.length} object(s) to Teamwork Graph`);
  }

  return {
    published: response.success === true && rejected.length === 0,
    accepted: accepted.length,
    rejected,
    error: response.error,
  };
}
