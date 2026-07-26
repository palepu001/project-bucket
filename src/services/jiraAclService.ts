import api, { route } from '@forge/api';
import { types } from '@forge/teamwork-graph';

// F7 Milestone 3.5 — resolves "who can view this Jira issue" into Teamwork
// Graph principals by mirroring Jira's own grant structure (permission scheme
// BROWSE_PROJECTS grants + project-role actors), NOT by enumerating users.
// Mirroring the structure keeps principal counts far below the graph's
// 500-principal-per-object cap: a typical scheme grants browse to a handful
// of groups/roles regardless of how many thousands of users they contain.
//
// FAIL-CLOSED INVARIANT: if any part of the resolution cannot be completed —
// an API call fails, a grant type can't be mirrored, the issue carries a
// security level (member resolution not yet supported), or the principal
// count would exceed the cap — the caller falls back to an uploader-only ACL.
// Ingested metadata may become LESS visible than native Jira, never more.

export interface ResolvedAcl {
  // How the ACL was derived. 'MIRRORED' = real Jira grants; 'FAIL_CLOSED' =
  // uploader-only fallback, with `reason` saying why.
  mode: 'MIRRORED' | 'FAIL_CLOSED';
  reason?: string;
  permissions: types.Permissions[];
  // Jira groups referenced as GROUP principals; the sync layer must ingest
  // these (setGroups + member mapUsers) before/with the objects.
  groups: { groupId: string; name: string }[];
  // Atlassian accountIds referenced as USER principals (plus group members);
  // the sync layer must register these via mapUsers.
  userAccountIds: string[];
}

export interface IssueContext {
  issueId: string;
  issueKey: string;
  projectId: string;
  projectKey: string;
  securityLevelId: string | null;
}

// The graph caps principals across all access controls at 500 per object.
const MAX_PRINCIPALS = 500;

async function getJson(path: ReturnType<typeof route>): Promise<any> {
  const response = await api.asApp().requestJira(path, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Jira API request failed with status ${response.status}`);
  }
  return response.json();
}

export async function getIssueContext(issueId: string): Promise<IssueContext> {
  const issue = await getJson(route`/rest/api/3/issue/${issueId}?fields=project,security`);
  return {
    issueId,
    issueKey: issue.key,
    projectId: issue.fields?.project?.id,
    projectKey: issue.fields?.project?.key,
    securityLevelId: issue.fields?.security?.id ?? null,
  };
}

interface PermissionGrantHolder {
  type: string;
  value?: string;
  parameter?: string;
  group?: { groupId?: string; name?: string };
  user?: { accountId?: string };
  projectRole?: { id?: number; name?: string };
}

// Resolves the BROWSE_PROJECTS grants of the project's permission scheme into
// graph principals. Throws on anything it cannot mirror faithfully — the
// caller converts that into the fail-closed fallback.
async function resolveBrowseGrants(projectId: string): Promise<{
  principals: types.Principal[];
  groups: { groupId: string; name: string }[];
  userAccountIds: string[];
}> {
  const scheme = await getJson(
    route`/rest/api/3/project/${projectId}/permissionscheme?expand=permissions,user,group,projectRole`
  );

  const browseGrants = (scheme.permissions ?? []).filter(
    (grant: { permission?: string }) => grant.permission === 'BROWSE_PROJECTS'
  );
  if (browseGrants.length === 0) {
    throw new Error(`Permission scheme ${scheme.id} returned no BROWSE_PROJECTS grants`);
  }

  const principals: types.Principal[] = [];
  const groups = new Map<string, string>();
  const users = new Set<string>();

  for (const grant of browseGrants) {
    const holder = grant.holder as PermissionGrantHolder | undefined;
    if (!holder) continue;

    switch (holder.type) {
      case 'group': {
        const groupId = holder.group?.groupId ?? holder.value;
        const name = holder.group?.name ?? holder.parameter ?? groupId;
        if (!groupId) throw new Error('Group grant without a groupId');
        groups.set(groupId, name ?? groupId);
        break;
      }
      case 'user': {
        const accountId = holder.user?.accountId ?? holder.value;
        if (!accountId) throw new Error('User grant without an accountId');
        users.add(accountId);
        break;
      }
      case 'projectRole': {
        const roleId = holder.projectRole?.id ?? holder.value;
        if (!roleId) throw new Error('Project role grant without a role id');
        const role = await getJson(route`/rest/api/3/project/${projectId}/role/${roleId}`);
        for (const actor of role.actors ?? []) {
          if (actor.actorGroup?.groupId) {
            groups.set(actor.actorGroup.groupId, actor.actorGroup.displayName ?? actor.actorGroup.groupId);
          } else if (actor.actorUser?.accountId) {
            users.add(actor.actorUser.accountId);
          } else {
            throw new Error(`Unsupported project role actor type: ${actor.type}`);
          }
        }
        break;
      }
      case 'anyone':
      case 'applicationRole': {
        // 'anyone' means public (wider than the workspace) and
        // 'applicationRole' means every user with Jira product access.
        // ATLASSIAN_WORKSPACE is the closest supported principal: identical
        // or narrower than 'anyone'; for 'applicationRole' it can include
        // workspace members without Jira access — a bounded, documented
        // approximation (see F7 notes).
        principals.push({ type: 'ATLASSIAN_WORKSPACE' });
        break;
      }
      default:
        throw new Error(`Unsupported BROWSE_PROJECTS holder type: ${holder.type}`);
    }
  }

  // Server rule (observed in rejection responses): when ATLASSIAN_WORKSPACE
  // is present, listing additional users/groups is rejected as redundant —
  // the workspace grant is already a superset. Collapse to workspace-only,
  // which also removes any need to sync those groups' memberships.
  if (principals.some((principal) => principal.type === 'ATLASSIAN_WORKSPACE')) {
    return { principals: [{ type: 'ATLASSIAN_WORKSPACE' }], groups: [], userAccountIds: [] };
  }

  for (const [groupId] of groups) principals.push({ type: 'GROUP', id: groupId });
  for (const accountId of users) principals.push({ type: 'USER', id: accountId });

  if (principals.length === 0) {
    throw new Error('BROWSE_PROJECTS grants resolved to zero principals');
  }
  if (principals.length > MAX_PRINCIPALS) {
    throw new Error(`Resolved ${principals.length} principals, exceeding the ${MAX_PRINCIPALS} cap`);
  }

  return {
    principals,
    groups: Array.from(groups, ([groupId, name]) => ({ groupId, name })),
    userAccountIds: Array.from(users),
  };
}

function failClosed(uploaderAccountId: string, reason: string): ResolvedAcl {
  ((..._args: any[]) => {})(`[ProjectBucket] Graph ACL fail-closed (uploader-only): ${reason}`);
  return {
    mode: 'FAIL_CLOSED',
    reason,
    permissions: [{ accessControls: [{ principals: [{ type: 'USER', id: uploaderAccountId }] }] }],
    groups: [],
    userAccountIds: [uploaderAccountId],
  };
}

// Resolves the ACL for every Project Bucket object on this issue. One call per
// issue — all of an issue's attachments share the same visibility, exactly as
// in native Jira.
export async function resolveIssueAcl(
  context: IssueContext,
  uploaderAccountId: string
): Promise<ResolvedAcl> {
  // Issues carrying a security level restrict visibility to the level's
  // members. Member resolution needs admin-only APIs we have not verified,
  // so secured issues fail closed (uploader-only) rather than risk leaking.
  if (context.securityLevelId) {
    return failClosed(
      uploaderAccountId,
      `issue ${context.issueKey} has security level ${context.securityLevelId}`
    );
  }

  try {
    const browse = await resolveBrowseGrants(context.projectId);
    return {
      mode: 'MIRRORED',
      permissions: [{ accessControls: [{ principals: browse.principals }] }],
      groups: browse.groups,
      userAccountIds: browse.userAccountIds,
    };
  } catch (error) {
    return failClosed(uploaderAccountId, error instanceof Error ? error.message : String(error));
  }
}
