import api, { route } from '@forge/api';
import { graph, types } from '@forge/teamwork-graph';
import * as attachmentRepository from '../repositories/attachmentRepository';
import { getActiveConnection } from '../repositories/graphConnectionRepository';
import * as outboxRepository from '../repositories/graphOutboxRepository';
import { Attachment } from '../types/attachment';
import { getIssueContext, resolveIssueAcl, IssueContext, ResolvedAcl } from './jiraAclService';
import { publishDocuments, PublishResult } from './graphPublisher';

// F7 Milestones 6–8 — turns Project Bucket attachment rows (Forge SQL, the
// system of record) into atlassian:document metadata objects in Teamwork
// Graph, keeps them updated, and removes them on delete. Metadata ONLY: the
// file bytes in storage backend are never read here.

const OBJECT_TYPE = 'atlassian:document';
// SDK bulk endpoints cap every collection at 100 entries per call.
const CHUNK = 100;
// Group membership pagination cap. Members beyond this are not synced — those
// users lose graph visibility (narrower than Jira, never wider) and we log it.
const MAX_GROUP_MEMBERS = 500;

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Site base URL for building the document's link target. Fetched once per
// runtime instance; Jira serverInfo is stable for the life of a site.
let cachedBaseUrl: string | null = null;
async function getBaseUrl(): Promise<string> {
  if (cachedBaseUrl) return cachedBaseUrl;
  const response = await api.asApp().requestJira(route`/rest/api/3/serverInfo`);
  if (!response.ok) throw new Error(`serverInfo failed with status ${response.status}`);
  const info = await response.json();
  cachedBaseUrl = info.baseUrl as string;
  return cachedBaseUrl;
}

// SQL DATETIME columns read back as 'YYYY-MM-DD HH:MM:SS' (UTC by this app's
// convention — see src/db/time.ts); the graph wants ISO 8601.
function toIso(value: string): string {
  if (value.includes('T')) return new Date(value).toISOString();
  return new Date(`${value.replace(' ', 'T')}Z`).toISOString();
}

// Not re-exported by the SDK's types index, so derive it from DocumentObject.
type DocumentCategory = NonNullable<
  types.DocumentObject['atlassian:document']['type']['category']
>;

function categoryFor(extension: string, mimeType: string): DocumentCategory {
  if (mimeType.startsWith('image/')) return 'IMAGE';
  if (mimeType.startsWith('video/')) return 'VIDEO';
  if (mimeType.startsWith('audio/')) return 'AUDIO';
  if (mimeType === 'application/pdf' || extension === 'pdf') return 'PDF';
  const ext = extension.toLowerCase();
  if (['xls', 'xlsx', 'csv', 'ods', 'numbers'].includes(ext)) return 'SPREADSHEET';
  if (['ppt', 'pptx', 'odp', 'key'].includes(ext)) return 'PRESENTATION';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2'].includes(ext)) return 'ARCHIVE';
  if (['js', 'ts', 'tsx', 'jsx', 'py', 'java', 'go', 'rb', 'c', 'cpp', 'cs', 'sh', 'sql'].includes(ext)) return 'CODE';
  if (['doc', 'docx', 'txt', 'md', 'odt', 'rtf', 'json', 'xml', 'yaml', 'yml', 'log'].includes(ext)) return 'DOCUMENT';
  return 'OTHER';
}

// content.text is REQUIRED by the graph (it rejects an empty content object;
// see memory f7-document-content-required). It is composed exclusively from
// metadata Project Bucket already holds — never from the file's bytes.
function metadataDescriptor(attachment: Attachment, context: IssueContext): string {
  return (
    `${attachment.filename} (${attachment.mimeType}, ${attachment.size} bytes) — ` +
    `Project Bucket attachment on ${context.issueKey} in project ${context.projectKey}`
  );
}

function toDocumentObject(
  attachment: Attachment,
  context: IssueContext,
  acl: ResolvedAcl,
  baseUrl: string
): types.DocumentObject {
  return {
    schemaVersion: '2.0',
    id: attachment.id,
    updateSequenceNumber: Date.now(),
    displayName: attachment.filename,
    url: `${baseUrl}/apps/ed95ed2a-5bfc-413b-a263-27e9cd176f22/project-bucket-router?attachmentId=${attachment.id}`,
    createdAt: toIso(attachment.uploadedAt),
    lastUpdatedAt: toIso(attachment.lastModified),
    createdBy: { accountId: attachment.uploadedBy },
    permissions: acl.permissions,
    'atlassian:document': {
      type: {
        category: categoryFor(attachment.extension, attachment.mimeType),
        mimeType: attachment.mimeType,
        fileExtension: attachment.extension,
      },
      content: { mimeType: 'text/plain', text: metadataDescriptor(attachment, context) },
      byteSize: attachment.size,
    },
  };
}

interface GroupMember {
  accountId: string;
}

async function fetchGroupMembers(groupId: string): Promise<GroupMember[]> {
  const members: GroupMember[] = [];
  let startAt = 0;
  for (;;) {
    const response = await api
      .asApp()
      .requestJira(route`/rest/api/3/group/member?groupId=${groupId}&startAt=${startAt}&maxResults=50`);
    if (!response.ok) throw new Error(`group/member failed with status ${response.status} for group ${groupId}`);
    const page = await response.json();
    for (const value of page.values ?? []) {
      if (value.accountId) members.push({ accountId: value.accountId });
    }
    if (page.isLast || members.length >= MAX_GROUP_MEMBERS) {
      if (!page.isLast) {
        ((..._args: any[]) => {})(
          `[ProjectBucket] Group ${groupId} exceeds ${MAX_GROUP_MEMBERS} synced members; remainder not synced (fail-closed)`
        );
      }
      return members;
    }
    startAt += 50;
  }
}

// Registers the principals an ACL references so the graph can resolve them:
// groups via setGroups (with membership), every referenced accountId via
// mapUsers (externalId := accountId — our "external system" IS Jira, so the
// mapping is 1:1 by construction).
async function ensurePrincipals(connectionId: string, acl: ResolvedAcl): Promise<void> {
  const accountIds = new Set<string>(acl.userAccountIds);

  const groupPayloads: types.GroupPayload[] = [];
  for (const group of acl.groups) {
    const members = await fetchGroupMembers(group.groupId);
    for (const member of members) accountIds.add(member.accountId);
    groupPayloads.push({
      externalId: group.groupId,
      displayName: group.name,
      members: members.map((member) => ({ externalId: member.accountId, type: 'USER' })),
    });
  }

  const now = Date.now();
  for (const batch of chunked(Array.from(accountIds), CHUNK)) {
    const result = await graph.mapUsers({
      connectionId,
      directMappings: batch.map((accountId) => ({
        externalId: accountId,
        accountId,
        updateSequenceNumber: now,
        updatedAt: now,
      })),
    });
    if (!result.success) throw new Error(`mapUsers failed: ${result.error}`);
  }

  for (const batch of chunked(groupPayloads, CHUNK)) {
    const result = await graph.setGroups({ connectionId, groups: batch });
    if (!result.success) throw new Error(`setGroups failed: ${result.error}`);
  }
}

export interface IssueSyncResult extends PublishResult {
  issueId: string;
  aclMode?: ResolvedAcl['mode'];
}

// Publishes (creates or updates — setObjects upserts) every given attachment
// of ONE issue. All attachments on an issue share one ACL, mirroring Jira.
async function publishForIssue(issueId: string, attachments: Attachment[]): Promise<IssueSyncResult> {
  if (attachments.length === 0) return { issueId, published: true, accepted: 0, rejected: [] };

  const connection = await getActiveConnection();
  if (!connection) {
    return { issueId, published: false, accepted: 0, rejected: [], skippedReason: 'NO_CONNECTION' };
  }

  const context = await getIssueContext(issueId);
  const acl = await resolveIssueAcl(context, attachments[0].uploadedBy);
  await ensurePrincipals(connection.connectionId, acl);

  const baseUrl = await getBaseUrl();
  let accepted = 0;
  let allPublished = true;
  let firstError: string | undefined;
  const rejected: types.RejectedObject[] = [];
  for (const batch of chunked(attachments, CHUNK)) {
    const result = await publishDocuments(
      batch.map((attachment) => toDocumentObject(attachment, context, acl, baseUrl))
    );
    accepted += result.accepted;
    rejected.push(...result.rejected);
    if (!result.published) allPublished = false;
    firstError = firstError ?? result.error;
  }

  return { issueId, published: allPublished, accepted, rejected, error: firstError, aclMode: acl.mode };
}

// Entry point for create/update paths (recordAttachments, migration commits).
// Never throws: graph publishing must not break uploads — failures are logged
// and healed by the reconciliation sweep.
export async function publishAttachments(attachments: Attachment[]): Promise<IssueSyncResult[]> {
  const byIssue = new Map<string, Attachment[]>();
  for (const attachment of attachments) {
    const list = byIssue.get(attachment.issueId) ?? [];
    list.push(attachment);
    byIssue.set(attachment.issueId, list);
  }

  const results: IssueSyncResult[] = [];
  for (const [issueId, group] of byIssue) {
    try {
      const result = await publishForIssue(issueId, group);
      if (result.skippedReason !== 'NO_CONNECTION') {
        ((..._args: any[]) => {})(
          `[ProjectBucket] Graph sync issue ${issueId}: accepted=${result.accepted} rejected=${result.rejected.length} acl=${result.aclMode}`
        );
      }
      results.push(result);
    } catch (error) {
      console.error(`[ProjectBucket] Graph sync failed for issue ${issueId}:`, error);
      results.push({
        issueId,
        published: false,
        accepted: 0,
        rejected: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

// Republishes everything Project Bucket holds on an issue — the event-driven
// ACL refresh (issue updated → security/visibility may have changed).
export async function republishIssue(issueId: string): Promise<IssueSyncResult | null> {
  const attachments = await attachmentRepository.listAttachments({ issueId });
  if (attachments.length === 0) return null;
  const [result] = await publishAttachments(attachments);
  return result ?? null;
}

// M8 — removes objects from the graph after their rows are deleted. Never
// throws. A failed (or connection-less) delete is queued in the outbox so
// the reconciliation sweep retries it — a ghost object with stale metadata
// must never outlive its attachment permanently.
export async function publishDeletes(attachmentIds: string[]): Promise<boolean> {
  if (attachmentIds.length === 0) return true;
  const connection = await getActiveConnection();
  if (!connection) {
    await outboxRepository.enqueueFailedDeletes(attachmentIds).catch(() => undefined);
    return false;
  }

  try {
    for (const batch of chunked(attachmentIds, CHUNK)) {
      const result = await graph.deleteObjectsByExternalId({
        connectionId: connection.connectionId,
        objectType: OBJECT_TYPE,
        externalIds: batch,
      });
      if (!result.success) throw new Error(result.error ?? 'unknown error');
    }
    await outboxRepository.clearDeletes(attachmentIds).catch(() => undefined);
    ((..._args: any[]) => {})(`[ProjectBucket] Deleted ${attachmentIds.length} object(s) from Teamwork Graph`);
    return true;
  } catch (error) {
    console.error('[ProjectBucket] Graph delete failed; queued for sweep retry:', error);
    await outboxRepository.enqueueFailedDeletes(attachmentIds).catch(() => undefined);
    return false;
  }
}

// The reconciliation sweep (F7 Option B): drain queued deletes, then refresh
// every ACTIVE attachment's metadata and ACLs. Returns false if anything
// failed so the task run can be reported as a (retryable) failure.
export async function runReconciliationSweep(): Promise<boolean> {
  const pendingDeletes = await outboxRepository.listPendingDeletes();
  const deletesOk = await publishDeletes(pendingDeletes);

  const attachments = await attachmentRepository.listAllActiveAttachments();
  const results = await publishAttachments(attachments);
  const publishesOk = results.every(
    (result) => result.published || result.skippedReason === 'NO_CONNECTION'
  );

  ((..._args: any[]) => {})(
    `[ProjectBucket] Reconciliation sweep: retriedDeletes=${pendingDeletes.length} attachments=${attachments.length} deletesOk=${deletesOk} publishesOk=${publishesOk}`
  );
  return deletesOk && publishesOk;
}
