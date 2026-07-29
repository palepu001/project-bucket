import api, { route } from '@forge/api';

// Removes the "dead object" cards a migration would otherwise leave behind.
//
// When a user embeds a file in the issue description or a comment, Jira
// stores the bytes as a native attachment AND writes a `media` node into the
// field's ADF document. Deleting the attachment (which migration does) does
// NOT touch that ADF node, so the editor keeps rendering a broken
// "Failed to load" card pointing at a file that no longer exists. This module
// finds and removes those nodes so the only place a migrated file appears is
// the Project Bucket panel.
//
// The tricky part is identity: ADF media nodes reference a Media Services
// UUID (`attrs.id`), while the attachment REST API only knows the numeric
// attachment id — and no public endpoint maps one to the other. The reliable
// bridge is the content redirect: GET /rest/api/3/attachment/content/{id}
// answers with a redirect to `https://api.media.atlassian.com/file/<UUID>/binary?...`,
// so the UUID can be parsed out of the redirect target. That only works while
// the attachment still exists, which is why migrationService resolves the
// UUIDs BEFORE deleting the native copies and passes them in here afterwards.
//
// Everything in this module is best-effort by design: the migrated bytes are
// already safe in Project Bucket by the time cleanup runs, so a cleanup
// failure (no edit permission on someone else's comment, a concurrent edit,
// an API hiccup) must never fail the migration run. Callers get a thrown
// error for nothing; we log and move on.

// A deliberately loose ADF shape — we only ever inspect `type`, `attrs.id`,
// `attrs.type` and recurse through `content`; every other property is carried
// through untouched so we can never corrupt a node we don't understand.
interface AdfNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  [key: string]: unknown;
}

const MEDIA_UUID_PATTERN = /\/file\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i;

// Above this many surviving attachments we skip the orphan sweep (see
// removeMediaReferences) rather than fire an unbounded number of
// resolveMediaId calls inside one resolver invocation.
const ORPHAN_SWEEP_MAX_ATTACHMENTS = 30;

/**
 * Resolves the Media Services UUID that ADF media nodes use to reference a
 * native Jira attachment. Must be called while the attachment still exists.
 * Returns null (never throws) when the UUID cannot be determined.
 */
export async function resolveMediaId(attachmentId: string): Promise<string | null> {
  try {
    // `redirect: 'manual'` keeps the redirect response so we can read its
    // Location header without downloading the file. If the runtime follows
    // the redirect anyway, the final response URL embeds the same UUID — and
    // the Range header keeps that fallback download to a single byte.
    const response = await api.asUser().requestJira(route`/rest/api/3/attachment/content/${attachmentId}`, {
      headers: { Range: 'bytes=0-0' },
      redirect: 'manual',
    });
    const target = response.headers.get('location') ?? (response as unknown as { url?: string }).url ?? '';
    const match = MEDIA_UUID_PATTERN.exec(target);
    return match ? match[1].toLowerCase() : null;
  } catch (error) {
    ((..._args: any[]) => {})(`[ProjectBucket] Could not resolve media id for attachment ${attachmentId}:`, error);
    return null;
  }
}

// Walks one ADF document and removes every attachment-backed media node
// (`media` / `mediaInline` with attrs.type !== 'external') whose UUID the
// predicate marks for removal. `mediaSingle` / `mediaGroup` wrappers that no
// longer contain any media afterwards are dropped wholesale, so no empty
// grey placeholder frame is left behind. Returns the removal count so
// callers can skip the write entirely when nothing matched.
// Walks one ADF document and replaces every attachment-backed media node
// (`media` / `mediaInline` with attrs.type !== 'external') whose UUID the
// predicate marks for removal.
// If replacing children of mediaSingle / mediaGroup wrappers, the wrappers
// are unwrapped and their text children are converted to standard paragraphs
// so the ADF document schema remains valid.
// Returns the replacement count so callers can skip the write when nothing matched.
function replaceMediaNodes(
  doc: AdfNode,
  shouldRemove: (mediaId: string) => { remove: boolean; filename?: string }
): { doc: AdfNode; removed: number } {
  let removed = 0;

  function cleanNodes(nodes: AdfNode[]): AdfNode[] {
    const kept: AdfNode[] = [];
    for (const node of nodes) {
      if ((node.type === 'media' || node.type === 'mediaInline') && node.attrs?.type !== 'external') {
        const mediaId = typeof node.attrs?.id === 'string' ? node.attrs.id.toLowerCase() : null;
        if (mediaId) {
          const match = shouldRemove(mediaId);
          if (match.remove) {
            removed += 1;
            const filename = match.filename ?? 'Attachment';
            kept.push({
              type: 'text',
              text: `📎 [${filename} migrated to Project Bucket]`,
              marks: [
                {
                  type: 'em',
                },
              ],
            });
            continue;
          }
        }
      }

      if (Array.isArray(node.content)) {
        const cleanedContent = cleanNodes(node.content);
        if (node.type === 'mediaSingle' || node.type === 'mediaGroup') {
          const mediaChildren = cleanedContent.filter((child) => child.type === 'media');
          const textChildren = cleanedContent.filter((child) => child.type === 'text');

          if (textChildren.length > 0) {
            // Replaced children are inline text elements. We extract them into a separate paragraph block.
            kept.push({
              type: 'paragraph',
              content: textChildren,
            });
          }

          if (mediaChildren.length > 0) {
            // Keep remaining media elements in their original container wrapper
            kept.push({
              ...node,
              content: mediaChildren,
            });
          } else if (textChildren.length === 0) {
            // Fallback for empty wrappers with no text output
            removed += 1;
          }
          continue;
        }
        kept.push({ ...node, content: cleanedContent });
      } else {
        kept.push(node);
      }
    }
    return kept;
  }

  return { doc: { ...doc, content: cleanNodes(doc.content ?? []) }, removed };
}

// A comment whose only content was the migrated file collapses to nothing but
// empty paragraphs after stripping — treat that as an empty comment.
function isEffectivelyEmpty(doc: AdfNode): boolean {
  return (doc.content ?? []).every(
    (node) => node.type === 'paragraph' && (node.content === undefined || node.content.length === 0)
  );
}

/**
 * Removes ADF media references to migrated (now deleted) native attachments
 * from the issue's description and comments, replacing them with a placeholder.
 *
 * `deletedMediaMap` maps UUIDs resolved before deletion to their filename. On top of those,
 * this also sweeps ORPHANED references — media nodes pointing at attachments
 * that no longer exist at all. The sweep is guarded: it only engages when the UUID
 * of EVERY surviving attachment resolved successfully.
 */
export async function removeMediaReferences(
  issueId: string,
  deletedMediaMap: Record<string, string>
): Promise<void> {
  const issueResponse = await api.asUser().requestJira(route`/rest/api/3/issue/${issueId}?fields=description,attachment`);
  if (!issueResponse.ok) {
    throw new Error(`Failed to load issue ${issueId} for media cleanup: HTTP ${issueResponse.status}`);
  }
  const issue = (await issueResponse.json()) as {
    fields: { description: AdfNode | null; attachment?: { id: string }[] };
  };

  const survivors = issue.fields.attachment ?? [];
  let liveMediaIds: Set<string> | null = null;
  if (survivors.length <= ORPHAN_SWEEP_MAX_ATTACHMENTS) {
    const resolved = await Promise.all(survivors.map((attachment) => resolveMediaId(attachment.id)));
    if (resolved.every((id): id is string => id !== null)) {
      liveMediaIds = new Set(resolved.map((id) => id.toLowerCase()));
    }
  }

  const shouldRemove = (mediaId: string): { remove: boolean; filename?: string } => {
    const lowerId = mediaId.toLowerCase();
    if (deletedMediaMap[lowerId] !== undefined) {
      return { remove: true, filename: deletedMediaMap[lowerId] };
    }
    if (liveMediaIds !== null && !liveMediaIds.has(lowerId)) {
      return { remove: true };
    }
    return { remove: false };
  };

  await cleanDescription(issueId, issue.fields.description, shouldRemove);
  await cleanComments(issueId, shouldRemove);
}

async function cleanDescription(
  issueId: string,
  description: AdfNode | null,
  shouldRemove: (mediaId: string) => { remove: boolean; filename?: string }
): Promise<void> {
  if (!description) return;
  const { doc, removed } = replaceMediaNodes(description, shouldRemove);
  if (removed === 0) return;

  try {
    // notifyUsers=false: this is invisible housekeeping, not an edit anyone
    // needs an email about.
    const response = await api.asUser().requestJira(route`/rest/api/3/issue/${issueId}?notifyUsers=false`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { description: doc } }),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (error) {
    ((..._args: any[]) => {})(`[ProjectBucket] Could not clean migrated media out of issue ${issueId} description:`, error);
  }
}

async function cleanComments(
  issueId: string,
  shouldRemove: (mediaId: string) => { remove: boolean; filename?: string }
): Promise<void> {
  const pageSize = 50;
  // Hard cap so one pathological issue can't keep a resolver invocation
  // paginating forever; 500 comments is far beyond any issue this app targets.
  const maxComments = 500;

  for (let startAt = 0; startAt < maxComments; startAt += pageSize) {
    let page: { comments: { id: string; body: AdfNode | null }[]; total: number };
    try {
      const response = await api
        .asUser()
        .requestJira(route`/rest/api/3/issue/${issueId}/comment?startAt=${startAt}&maxResults=${pageSize}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      page = (await response.json()) as typeof page;
    } catch (error) {
      ((..._args: any[]) => {})(`[ProjectBucket] Could not list comments on issue ${issueId} for media cleanup:`, error);
      return;
    }

    for (const comment of page.comments) {
      if (!comment.body) continue;
      const { doc, removed } = replaceMediaNodes(comment.body, shouldRemove);
      if (removed === 0) continue;

      try {
        if (isEffectivelyEmpty(doc)) {
          // The comment existed only to carry the file; with the file now in
          // Project Bucket an empty husk of a comment is just more clutter.
          const response = await api
            .asUser()
            .requestJira(route`/rest/api/3/issue/${issueId}/comment/${comment.id}`, { method: 'DELETE' });
          if (!response.ok && response.status !== 404) {
            throw new Error(`HTTP ${response.status}`);
          }
        } else {
          const response = await api
            .asUser()
            .requestJira(route`/rest/api/3/issue/${issueId}/comment/${comment.id}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ body: doc }),
            });
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
        }
      } catch (error) {
        // Most likely a permission gap (editing/deleting someone else's
        // comment). The dead card stays for that comment — annoying but safe.
        ((..._args: any[]) => {})(`[ProjectBucket] Could not clean migrated media out of comment ${comment.id}:`, error);
      }
    }

    if (startAt + pageSize >= page.total) return;
  }
}
