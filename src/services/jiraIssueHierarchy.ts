import api, { route } from '@forge/api';

// projectKey/issueKey/epicKey for one issue, used to build the deterministic
// storage key (see util/storageKey.ts). A single "Link All" migration run
// asks for this once per item it stages, plus once more per item's thumbnail
// upload — for an 8-file session that's up to 16 redundant round trips to the
// SAME Jira issue for data that cannot change mid-run. Cached here so every
// caller within a short window shares one fetch.
//
// TIME-BOUNDED, not permanent, for the same reason storage/index.ts's
// provider cache is: an issue moving project or epic is rare but not
// impossible, and Forge gives no cross-container invalidation signal.
const HIERARCHY_TTL_MS = 60_000;

export interface IssueHierarchy {
  projectKey: string;
  issueKey: string;
  epicKey: string | null;
}

interface CacheEntry {
  value: Promise<IssueHierarchy>;
  expiresAt: number;
}

const hierarchyCache = new Map<string, CacheEntry>();

export function getIssueHierarchy(issueId: string): Promise<IssueHierarchy> {
  const entry = hierarchyCache.get(issueId);
  if (entry && Date.now() < entry.expiresAt) {
    return entry.value;
  }

  const value = (async () => {
    const issueResponse = await api.asApp().requestJira(route`/rest/api/3/issue/${issueId}?fields=project,parent`);
    const issueData = await issueResponse.json();
    return {
      projectKey: issueData.fields.project.key,
      issueKey: issueData.key,
      epicKey: issueData.fields.parent ? issueData.fields.parent.key : null,
    };
  })();

  // Don't cache a rejected fetch — a transient Jira error should not poison
  // every subsequent call for the rest of the TTL window.
  value.catch(() => hierarchyCache.delete(issueId));

  hierarchyCache.set(issueId, { value, expiresAt: Date.now() + HIERARCHY_TTL_MS });
  return value;
}
