import api, { route } from '@forge/api';
import { randomUUID } from 'crypto';
import Resolver from '@forge/resolver';
import { FileNormalizer } from '../shared/security/normalizer';
import { validateStateless } from '../shared/security/validators/statelessPipeline';
import { getStorageProvider, ChecksumType } from '../storage';
import { ObjectNotFoundError } from '../storage/ObjectNotFoundError';
import { generateStorageKey, StorageKeyContext } from '../util/storageKey';
import { mapSettledWithConcurrency } from '../util/concurrency';
import { extensionOf, AttachmentThumbnailStatus } from '../types/attachment';
import * as attachmentRepository from '../repositories/attachmentRepository';
import * as sessionService from '../services/sessionService';
import * as migrationService from '../services/migrationService';
import { getIssueHierarchy } from '../services/jiraIssueHierarchy';
import * as graphSyncService from '../services/graphSyncService';
import * as storageConsistencyService from '../services/storageConsistencyService';
import { verifyIssueAccess } from '../services/jiraIssueAccessService';
import { assertStoredObjectMatchesFilename } from '../services/contentSignatureService';

const resolver = new Resolver();

function requireAccountId(context: { accountId?: string | null }): string {
  if (!context.accountId) {
    throw new Error('This action requires an authenticated user.');
  }
  return context.accountId;
}

// ---------------------------------------------------------------------------
// Gallery: list / search / filter
// ---------------------------------------------------------------------------

resolver.define('listAttachments', async (req) => {
  const { issueId, search, extension } = req.payload as { issueId: string; search?: string; extension?: string };
  if (!issueId) throw new Error('listAttachments requires an issueId');
  const attachments = await attachmentRepository.listAttachments({ issueId, search, extension });

  // Invariant: a file only appears in Project Bucket while its bytes exist at
  // the storage location. Rows we cannot verify right now are HIDDEN from this
  // response but NOT quarantined — quarantine is the hourly sweep's job, and
  // only after a confirmed second miss, so one transient/regressed read can
  // never destructively hide a live library. On a transient storage failure we
  // fall back to the unverified list — the preview path degrades gracefully,
  // and hiding live files would be worse.
  try {
    const { present } = await storageConsistencyService.partitionByStoredBytes(attachments);
    return present;
  } catch (error) {
    console.error('[ProjectBucket] Storage existence check failed; returning unverified list:', error);
    return attachments;
  }
});

// `disposition` decides whether the minted URL renders the bytes or saves them:
//   'inline'     (default) — preview surfaces: <img>, <video>, <audio>, iframes.
//   'attachment'           — the Download action.
// The distinction has to be made HERE because the browser cannot make it: an
// `<a download>` hint is ignored for cross-origin URLs, and the storage
// location's URL is always cross-origin to the Forge iframe. Without this the
// Download action navigated instead of saving, and saved under the opaque
// object key (a UUID, no extension) when it saved at all.
resolver.define('getDownloadUrl', async (req) => {
  const { attachmentId, disposition } = req.payload as {
    attachmentId: string;
    disposition?: 'inline' | 'attachment';
  };
  const attachment = await attachmentRepository.getAttachmentById(attachmentId);
  if (!attachment) throw new Error(`Attachment "${attachmentId}" was not found`);

  await verifyIssueAccess(attachment.issueId);
  try {
    const provider = await getStorageProvider({ projectId: attachment.projectId });
    const { url } = await provider.download(
      attachment.objectKey,
      disposition === 'attachment' ? { downloadFilename: attachment.filename } : undefined
    );
    return { url, filename: attachment.filename, mimeType: attachment.mimeType, size: attachment.size };
  } catch (err) {
    // If the bytes are genuinely missing from the location, return a structured
    // "unavailable" response so the frontend shows a friendly message instead
    // of a raw error. We do NOT quarantine here — a single on-demand miss is not
    // proof of loss; the hourly sweep owns the ACTIVE → ORPHANED decision after
    // a confirmed second miss, so a transient read never withdraws a live file.
    if (err instanceof ObjectNotFoundError) {
      return { url: null, unavailable: true, filename: attachment.filename, mimeType: attachment.mimeType, size: attachment.size };
    }
    throw err;
  }
});

// Mints URLs for the generated preview images the gallery grid paints, one
// round-trip for the whole page of cards. This replaced a variant that returned
// URLs for the ORIGINAL bytes, which meant painting a grid of photos downloaded
// every photo at full size. Attachments without a stored rendition are simply
// absent from the response and fall back to their file-type icon.
resolver.define('getThumbnailUrls', async (req) => {
  const { attachmentIds } = req.payload as { attachmentIds: string[] };
  if (!Array.isArray(attachmentIds) || attachmentIds.length === 0) {
    throw new Error('getThumbnailUrls requires a non-empty attachmentIds array');
  }
  if (attachmentIds.length > 100) {
    throw new Error('getThumbnailUrls accepts at most 100 attachment ids per call');
  }

  const attachments = (await Promise.all(
    attachmentIds.map((id) => attachmentRepository.getAttachmentById(id))
  )).filter((a): a is NonNullable<typeof a> => a !== null && !!a.thumbnailKey);

  const byIssue = new Map<string, typeof attachments>();
  for (const a of attachments) {
    if (!byIssue.has(a.issueId)) byIssue.set(a.issueId, []);
    byIssue.get(a.issueId)!.push(a);
  }

  const urls: Record<string, string> = {};
  for (const [issueId, issueAttachments] of byIssue.entries()) {
    try {
      await verifyIssueAccess(issueId);
    } catch (err) {
      console.warn(`[ProjectBucket] Skipping thumbnails for unauthorized/missing issue ${issueId}`);
      continue;
    }
    // Minting each URL costs a HEAD plus a signature, and a full gallery page
    // asks for up to 100 at once. Doing that sequentially put a single panel
    // open into multi-second territory against the function timeout, so fan out
    // at the same width the existence checks already use.
    const minted = await mapSettledWithConcurrency(
      issueAttachments,
      async (attachment) => {
        const provider = await getStorageProvider({ projectId: attachment.projectId });
        const { url } = await provider.download(attachment.thumbnailKey!);
        return { id: attachment.id, url };
      },
      10
    );
    for (const result of minted) {
      if (result.status === 'fulfilled') {
        urls[result.value.id] = result.value.url;
        continue;
      }
      // A thumbnail is progressive enhancement: a missing or unreadable one
      // falls back to the file-type icon. Never fail the whole page over it.
      if (result.reason instanceof ObjectNotFoundError) continue;
      console.warn('[ProjectBucket] Could not mint a thumbnail URL:', result.reason);
    }
  }
  return urls;
});

// Backfill hook. Rows predating the thumbnail feature — and every migrated
// attachment, which never passes through the upload path's generation step —
// carry a NULL thumbnail_status. The gallery renders those in the browser on
// first view and reports the result here. Recording UNSUPPORTED/FAILED matters
// as much as READY: it is what stops the panel retrying a file forever.
resolver.define('recordThumbnail', async (req) => {
  const { attachmentId, thumbnailKey, thumbnailStatus } = req.payload as {
    attachmentId: string;
    thumbnailKey: string | null;
    thumbnailStatus: AttachmentThumbnailStatus;
  };
  if (!attachmentId || !thumbnailStatus) {
    throw new Error('recordThumbnail requires an attachmentId and thumbnailStatus');
  }
  const attachment = await attachmentRepository.getAttachmentById(attachmentId);
  if (!attachment) throw new Error(`Attachment "${attachmentId}" was not found`);
  await verifyIssueAccess(attachment.issueId);

  await attachmentRepository.updateThumbnail(attachmentId, thumbnailKey ?? null, thumbnailStatus);

  // Nothing references the rendition we just replaced, so without this it would
  // sit in the bucket forever. Best-effort: the row already points at the new
  // object, and failing the call would only make the panel re-render a preview
  // that is already correct.
  const superseded = attachment.thumbnailKey;
  if (superseded && superseded !== thumbnailKey) {
    try {
      const provider = await getStorageProvider({ projectId: attachment.projectId });
      await provider.delete(superseded);
    } catch (err) {
      console.warn(`[ProjectBucket] Could not delete the superseded thumbnail for ${attachmentId}:`, err);
    }
  }
  return { success: true };
});

// ---------------------------------------------------------------------------
// Content proxy: returns file bytes as a base64 data-URL for previews that
// cannot use presigned S3 URLs directly (PDF iframes need application/pdf
// Content-Type; text/CSV fetch hits CORS since storage backend does not
// set Access-Control-Allow-Origin on presigned GETs). Capped at 10 MB to
// stay within Forge function response payload limits.
// ---------------------------------------------------------------------------

const MAX_PROXY_BYTES = 10 * 1024 * 1024; // 10 MB

resolver.define('getFileContent', async (req) => {
  const { attachmentId } = req.payload as { attachmentId: string };
  const attachment = await attachmentRepository.getAttachmentById(attachmentId);
  if (!attachment) throw new Error(`Attachment "${attachmentId}" was not found`);
  
  await verifyIssueAccess(attachment.issueId);

  if (attachment.size > MAX_PROXY_BYTES) {
    return { error: 'too-large', maxBytes: MAX_PROXY_BYTES };
  }

  try {
    // Read the raw bytes from the storage location, which returns a readable
    // reference with the full body (or null if nothing is stored at the ref).
    const provider = await getStorageProvider({ projectId: attachment.projectId });
    const obj = await provider.stream(attachment.objectKey);
    if (!obj) {
      return { error: 'not-found' };
    }
    // Convert the object body to a base64 string for transport to the frontend.
    const chunks: Uint8Array[] = [];
    if ('getReader' in obj.body) {
      const reader = obj.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    } else {
      for await (const chunk of obj.body as any) {
        chunks.push(chunk);
      }
    }
    const buffer = Buffer.concat(chunks);
    const base64 = buffer.toString('base64');
    const mimeType = attachment.mimeType || 'application/octet-stream';
    return { dataUrl: `data:${mimeType};base64,${base64}` };
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      return { error: 'not-found' };
    }
    throw err;
  }
});

// Read-only incident diagnostic. storage backend intentionally has no bucket-wide
// listing API, so the only reliable audit is to verify each key persisted in
// Project Bucket's SQL metadata for this issue. This lets the UI distinguish a
// missing object from one whose stored bytes no longer match its metadata.
resolver.define('getStorageAudit', async (req) => {
  const { issueId } = req.payload as { issueId: string };
  if (!issueId) throw new Error('getStorageAudit requires an issueId');
  
  await verifyIssueAccess(issueId);

  // Include ORPHANED rows: the audit is exactly where quarantined losses
  // must remain visible after the gallery stops listing them.
  const attachments = await attachmentRepository.listAttachments({ issueId, includeOrphaned: true });
  // We cannot easily do a single exists() call if attachments span multiple projects,
  // but they all belong to the same issue, meaning they all belong to the same project.
  const projectId = attachments.length > 0 ? attachments[0].projectId : null;
  const stored = projectId 
    ? await (await getStorageProvider({ projectId })).exists(attachments.map((attachment) => attachment.objectKey))
    : [];
  const storedByKey = new Map(
    stored
      .filter((r) => r.status === 'found' && r.summary)
      .map((r) => [r.ref, r.summary!])
  );

  return attachments.map((attachment) => {
    const object = storedByKey.get(attachment.objectKey);
    return {
      attachmentId: attachment.id,
      filename: attachment.filename,
      objectKey: attachment.objectKey,
      source: attachment.source,
      status: attachment.status,
      expectedSize: attachment.size,
      expectedChecksum: attachment.checksum,
      exists: Boolean(object),
      storedSize: object?.size ?? null,
      storedChecksum: object?.checksum ?? null,
      metadataMatches: object
        ? object.size === attachment.size && object.checksum === attachment.checksum
        : false,
    };
  });
});

// Deleting a file in Project Bucket removes every copy Project Bucket owns:
// the stored object, the generated preview image (a second object under the
// same row), the SQL row, and the Teamwork Graph metadata object.
//
// Deliberately NOT in scope: anything in Jira. A native attachment that still
// exists is one the migration either already confirmed deleted, or one the
// customer chose not to link when the detection popup offered — and that
// choice is theirs to keep. Jira's own attachment list is Jira's to manage.
resolver.define('deleteAttachment', async (req) => {
  const { attachmentId } = req.payload as { attachmentId: string };
  const attachment = await attachmentRepository.getAttachmentById(attachmentId);
  if (!attachment) throw new Error(`Attachment "${attachmentId}" was not found`);

  await verifyIssueAccess(attachment.issueId);

  // Delete the object first. If this throws we normally keep the SQL row so
  // the gallery never points at bytes we failed to remove — EXCEPT when the
  // object is already gone (the orphaned-entry cleanup that "Remove entry" in
  // UnavailablePreview drives): there is nothing to orphan, so removing the
  // row is exactly right. We only re-throw when the object still exists, i.e.
  // a genuine transient failure.
  try {
    const provider = await getStorageProvider({ projectId: attachment.projectId });
    await provider.delete(attachment.objectKey);
  } catch (err) {
    const provider = await getStorageProvider({ projectId: attachment.projectId });
    const [check] = await provider.exists([attachment.objectKey]);
    const stillExists = check?.status !== 'missing';
    if (stillExists) throw err;
  }
  // The generated preview image is a second object under the same row. Removing
  // it is best-effort on purpose: the file itself is already gone by here, so
  // failing the whole delete over a leftover thumbnail would strand the row and
  // leave the user unable to retry. A missed thumbnail is a harmless orphan.
  if (attachment.thumbnailKey) {
    const provider = await getStorageProvider({ projectId: attachment.projectId });
    await provider.delete(attachment.thumbnailKey).catch((err) => {
      console.warn(`[ProjectBucket] Could not delete thumbnail for ${attachmentId}:`, err);
    });
  }
  await attachmentRepository.deleteAttachmentRow(attachmentId);
  // F7: remove the metadata object from Teamwork Graph. Never throws — the
  // reconciliation sweep heals a missed delete.
  await graphSyncService.publishDeletes([attachmentId]);
  return { success: true };
});

// ---------------------------------------------------------------------------
// Direct upload ("Add Attachment"): browser uploads bytes straight to Forge
// storage backend via the @forge/bridge storage upload URL call, which is
// wired to the 'uploadObjects' functionKey below to mint presigned URLs.
// Metadata is only persisted afterward, once the bridge confirms success.
// ---------------------------------------------------------------------------

export interface UploadPayload {
  filename: string;
  size: number;
  mimeType: string;
  checksum: string;
}

resolver.define('uploadObjects', async (req) => {
  const { objects, issueId, projectId } = (req.payload ?? {}) as { objects?: UploadPayload[], issueId?: string, projectId?: string };
  if (!objects || !Array.isArray(objects)) {
    throw new Error('uploadObjects requires an objects array');
  }
  if (!issueId || !projectId) {
    throw new Error('uploadObjects requires issueId and projectId');
  }
  await verifyIssueAccess(issueId);
  
  // Cached — a migration session calls this once per item for that item's
  // thumbnail, all for the same issue. See services/jiraIssueHierarchy.ts.
  const hierarchy = await getIssueHierarchy(issueId);
  const storageContext: StorageKeyContext = {
    cloudId: req.context.installContext.replace('ari:cloud:jira::site/', ''),
    projectKey: hierarchy.projectKey,
    issueKey: hierarchy.issueKey,
    epicKey: hierarchy.epicKey,
  };
  
  const provider = await getStorageProvider({ projectId });

  const results = [];

  for (const obj of objects) {
    const normalizedName = FileNormalizer.normalizeFilename(obj.filename);
    const validation = validateStateless({ 
      filename: normalizedName, 
      size: obj.size, 
      mimeType: obj.mimeType 
    });

    if (!validation.passed) {
      // Hard block at the trust boundary. No presigned URL minted.
      results.push({
        success: false,
        message: validation.message
      });
      continue;
    }
    
    // Validation passed, prepare the upload target. No TTL is set, so the
    // stored object persists until the user deletes it.
    const key = generateStorageKey(storageContext);
    const target = await provider.upload({
      ref: key,
      length: obj.size,
      mimeType: obj.mimeType,
      checksum: obj.checksum,
      checksumType: 'SHA256',
      overwrite: false,
    });

    results.push({ success: true, url: target.url, key, method: target.method, headers: target.headers });
  }
  
  return results;
});

interface RecordAttachmentInput {
  key: string;
  filename: string;
  size: number;
  mimeType: string;
  checksum: string;
  // Storage handle for the preview image the browser rendered for this file,
  // uploaded in the SAME batch as the file itself. Absent when the type cannot
  // be rendered client-side or when rendering failed — neither is fatal.
  thumbnailKey?: string | null;
  thumbnailStatus?: AttachmentThumbnailStatus | null;
  projectKey?: string | null;
  issueKey?: string | null;
  epicKey?: string | null;
  storageBucket?: string | null;
}

resolver.define('recordAttachments', async (req) => {
  const { issueId, projectId, items } = req.payload as {
    issueId: string;
    projectId: string;
    items: RecordAttachmentInput[];
  };
  if (!issueId || !projectId || !Array.isArray(items) || items.length === 0) {
    throw new Error('recordAttachments requires issueId, projectId, and at least one item');
  }
  const uploadedBy = requireAccountId(req.context);
  await verifyIssueAccess(issueId);

  // Verify every object actually landed in the store before trusting it —
  // the browser reported "success", but this is the last line of defense
  // before we treat the upload as durable and show it in the gallery.
  const keys = items.map((item) => item.key);
  const provider = await getStorageProvider({ projectId });
  const stored = await provider.exists(keys);
  const storedByKey = new Map(
    stored
      .filter((r) => r.status === 'found' && r.summary)
      .map((r) => [r.ref, r.summary!])
  );

  const issueResponse = await api.asApp().requestJira(route`/rest/api/3/issue/${issueId}?fields=project,parent`);
  const issueData = await issueResponse.json();
  const hierarchy = {
    projectKey: issueData.fields.project.key,
    issueKey: issueData.key,
    epicKey: issueData.fields.parent ? issueData.fields.parent.key : null,
  };
  const storageBucket = provider.containerName;

  // Verify EVERY item before persisting ANY of them. This loop used to insert
  // as it went and throw on the first bad item, which committed the rows before
  // it and abandoned the rest — a half-recorded upload. Verification is now a
  // pure pass that collects failures, so the write below is all-or-nothing.
  const now = new Date().toISOString();
  const created = [];
  for (const item of items) {
    const summaryCheck = stored.find(r => r.ref === item.key);
    if (summaryCheck?.status === 'error') {
      throw new Error(`Upload verification failed for "${item.filename}" due to a transient storage error. Please retry.`);
    }
    const summary = storedByKey.get(item.key);
    if (!summary || summary.size !== item.size) {
      throw new Error(`Upload verification failed for "${item.filename}" — object was not found in storage`);
    }
    // Re-validate the name we are about to PERSIST. uploadObjects validated the
    // name supplied when the target was minted, but this is a separate call and
    // nothing binds the two: without this, a client could pass validation as
    // "report.png", then record the very same object as "payroll.exe".
    // Persisting the normalized form also keeps what the gallery shows, what a
    // download is named, and what was actually checked in agreement.
    const filename = FileNormalizer.normalizeFilename(item.filename);
    const nameCheck = validateStateless({ filename, size: item.size, mimeType: item.mimeType });
    if (!nameCheck.passed) {
      throw new Error(`"${item.filename}" cannot be recorded — ${nameCheck.message}`);
    }
    await assertStoredObjectMatchesFilename(provider, item.key, filename);
    const attachment = {
      id: randomUUID(),
      issueId,
      projectId,
      filename,
      extension: extensionOf(filename),
      mimeType: item.mimeType || 'application/octet-stream',
      size: item.size,
      checksum: item.checksum,
      objectKey: item.key,
      uploadedBy,
      uploadedAt: now,
      lastModified: now,
      status: 'ACTIVE' as const,
      syncStatus: 'READY' as const,
      source: 'PROJECT_BUCKET_UPLOAD' as const,
      jiraAttachmentId: null,
      thumbnailKey: item.thumbnailKey ?? null,
      thumbnailStatus: item.thumbnailStatus ?? null,
      projectKey: hierarchy.projectKey,
      issueKey: hierarchy.issueKey,
      epicKey: hierarchy.epicKey,
      storageBucket,
    };
    created.push(attachment);
  }

  // One upload action, one statement — see insertAttachments for why this must
  // not become a per-item loop again.
  await attachmentRepository.insertAttachments(created);
  // F7: publish the new metadata into Teamwork Graph. Must never fail the
  // upload — publishAttachments catches and logs internally, and the
  // reconciliation sweep heals anything missed.
  await graphSyncService.publishAttachments(created);
  return created;
});

// ---------------------------------------------------------------------------
// Bulk detection: polled by static/attachment-watcher
// ---------------------------------------------------------------------------

resolver.define('pollPendingSession', async (req) => {
  const { issueId } = req.payload as { issueId: string };
  if (!issueId) throw new Error('pollPendingSession requires an issueId');

  const session = await sessionService.pollForNotifiableSession(issueId);
  if (!session) return null;

  console.log(`[ProjectBucket] pollPendingSession: claimed session ${session.id} for issue ${issueId} (${session.items.length} DB items)`);

  try {
    // Sweep the issue for ALL current native attachments rather than relying
    // only on the items captured by the trigger. Because every successful
    // migration deletes the native copy, any attachment still on the issue is,
    // by definition, unmigrated and should be offered to the user.
    //
    // CRITICAL: if the sweep succeeds and returns 0 attachments there is
    // nothing left to migrate (all have already been moved, or the session was
    // triggered by an attachment that was immediately deleted). Returning null
    // suppresses the popup and avoids creating a migration run whose every item
    // will 404 in stageOne — the sequence that caused "Link All" to always
    // fail: the session existed in the DB, but no Jira copy remained to download.
    const response = await api.asUser().requestJira(route`/rest/api/3/issue/${issueId}?fields=attachment`);
    console.log(`[ProjectBucket] pollPendingSession: Jira sweep HTTP ${response.status} for issue ${issueId}`);
    if (response.ok) {
      const issue = await response.json();
      const nativeAttachments = issue.fields.attachment || [];
      console.log(`[ProjectBucket] pollPendingSession: sweep found ${nativeAttachments.length} native attachment(s) on issue ${issueId}`);

      if (nativeAttachments.length === 0) {
        // The sweep authoritatively found nothing to migrate. Suppress the
        // popup — the session is stale or all attachments were already linked.
        console.log(`[ProjectBucket] pollPendingSession: suppressing session ${session.id} — no native attachments remain on issue`);
        return null;
      }

      // Replace the DB-captured items with the live sweep result so the popup
      // names exactly the files Jira currently holds and so beginMigration
      // references real, downloadable attachment IDs.
      session.items = nativeAttachments.map((a: any) => ({
        id: randomUUID(),
        sessionId: session.id,
        jiraAttachmentId: a.id,
        filename: a.filename,
        size: a.size,
        mimeType: a.mimeType,
        authorAccountId: a.author?.accountId || 'unknown',
        detectedAt: new Date().toISOString(),
      }));
    } else {
      // The sweep API call itself failed (non-OK response). Fall back to the
      // DB-captured items so the popup still fires — better to attempt a
      // migration that might 404 on a single file than to silently swallow the
      // whole session. stageOne's 404 handling will fail the run gracefully.
      console.warn(
        `[ProjectBucket] Jira attachment sweep returned HTTP ${response.status} for issue ${issueId}; ` +
        'falling back to trigger-captured session items.'
      );
    }
  } catch (error) {
    // Network or parse error — same fallback as above. Log the error so it
    // appears in forge logs and can be diagnosed without suppressing the session.
    console.warn(`[ProjectBucket] Failed to sweep native attachments for session ${session.id}:`, error);
  }

  // Only return the session if there are items to act on. If the fallback
  // path left session.items empty (the trigger somehow recorded no items and
  // the sweep failed), suppress the popup rather than showing an empty one.
  if (!session.items || session.items.length === 0) {
    console.log(`[ProjectBucket] pollPendingSession: suppressing session ${session.id} — items list is empty after fallback`);
    return null;
  }

  console.log(`[ProjectBucket] pollPendingSession: returning session ${session.id} with ${session.items.length} item(s) to migrate`);
  return session;
});

resolver.define('dismissSession', async (req) => {
  const { sessionId } = req.payload as { sessionId: string };
  if (!sessionId) throw new Error('dismissSession requires a sessionId');
  await sessionService.dismissSession(sessionId);
  return { success: true };
});

// ---------------------------------------------------------------------------
// Migration pipeline: driven step-by-step by the browser (see
// services/migrationService.ts for why), called from static/attachment-watcher
// after "Link All" is confirmed, and from the panel's diagnostics tab for
// "Retry failed attachment".
// ---------------------------------------------------------------------------

resolver.define('beginMigration', async (req) => {
  const { issueId, projectId, sessionId, items } = req.payload as {
    issueId: string;
    projectId: string;
    sessionId: string | null;
    items: { jiraAttachmentId: string; filename: string }[];
  };
  if (!issueId || !projectId || !Array.isArray(items) || items.length === 0) {
    throw new Error('beginMigration requires issueId, projectId, and at least one item');
  }
  const triggeredBy = requireAccountId(req.context);
  await verifyIssueAccess(issueId);
  console.log(`[ProjectBucket] beginMigration: issueId=${issueId} projectId=${projectId} items=${items.length} files=[${items.map(i => i.filename).join(', ')}]`);
  const run = await migrationService.beginMigration({ issueId, projectId, sessionId: sessionId ?? null, triggeredBy, items });
  console.log(`[ProjectBucket] beginMigration: created run ${run.id} with ${run.items.length} item(s)`);
  return run;
});

resolver.define('getMigrationUploadTarget', async (req) => {
  const { migrationId, itemId, length, mimeType, checksum, checksumType } = req.payload as {
    migrationId: string;
    itemId: string;
    length: number;
    mimeType?: string;
    checksum: string;
    checksumType: ChecksumType;
  };
  // Minting the target is where the migration path enforces file validation —
  // see migrationService.getUploadTarget.
  requireAccountId(req.context);
  const cloudId = req.context.installContext.replace('ari:cloud:jira::site/', '');
  return migrationService.getUploadTarget({ migrationId, itemId, length, mimeType, checksum, checksumType, cloudId });
});

// PHASE 1: record that one item's bytes are verified in storage backend. Does not
// persist an attachment or touch the native Jira copy — see migrationService.
resolver.define('stageMigrationItem', async (req) => {
  const { migrationId, itemId, objectKey, mimeType, size, checksum, thumbnailKey, thumbnailStatus } =
    req.payload as {
      migrationId: string;
      itemId: string;
      objectKey: string;
      mimeType: string;
      size: number;
      checksum: string;
      thumbnailKey?: string | null;
      thumbnailStatus?: AttachmentThumbnailStatus | null;
    };
  // Require an authenticated user here too: only the eventual committer's
  // identity matters for the persisted attachment, but staging is a
  // user-initiated action and should never run unauthenticated.
  requireAccountId(req.context);
  return migrationService.stageMigrationItem({
    migrationId,
    itemId,
    objectKey,
    mimeType,
    size,
    checksum,
    thumbnailKey,
    thumbnailStatus,
  });
});

// The client's content validation rejected an item's bytes. Withdraws the item
// from the session (native Jira copy deliberately kept) instead of failing the
// whole run — see MigrationItemStatus.BLOCKED.
resolver.define('blockMigrationItem', async (req) => {
  const { migrationId, itemId, reason } = req.payload as {
    migrationId: string;
    itemId: string;
    reason: string;
  };
  requireAccountId(req.context);
  return migrationService.blockMigrationItem({ migrationId, itemId, reason });
});

resolver.define('failMigrationItem', async (req) => {
  const { migrationId, itemId, error } = req.payload as { migrationId: string; itemId: string; error: string };
  requireAccountId(req.context);
  await migrationService.failMigrationItem({ migrationId, itemId, error });
  return { success: true };
});

// The client saw a definitive 404 downloading an item's content — the native
// attachment was deleted before it could be linked. The service re-verifies
// against Jira before withdrawing the item from the session's transaction.
resolver.define('skipMissingMigrationItem', async (req) => {
  const { migrationId, itemId } = req.payload as { migrationId: string; itemId: string };
  requireAccountId(req.context);
  return migrationService.skipMissingMigrationItem({ migrationId, itemId });
});

// PHASE 2: the transaction boundary — commit the whole session at once (persist
// every attachment, then delete every native copy), or abort touching nothing.
resolver.define('commitMigrationRun', async (req) => {
  const { migrationId } = req.payload as { migrationId: string };
  const actorAccountId = requireAccountId(req.context);
  console.log(`[ProjectBucket] commitMigrationRun: migrationId=${migrationId}`);
  const result = await migrationService.commitMigrationRun({ migrationId, actorAccountId });
  console.log(`[ProjectBucket] commitMigrationRun: run ${migrationId} finished with status=${result.status} migrated=${result.migratedCount} failed=${result.failedCount}`);
  return result;
});

resolver.define('retryMigration', async (req) => {
  const { migrationId } = req.payload as { migrationId: string };
  requireAccountId(req.context);
  return migrationService.prepareRetry(migrationId);
});

resolver.define('getMigrationDiagnostics', async (req) => {
  const { issueId } = req.payload as { issueId: string };
  if (!issueId) throw new Error('getMigrationDiagnostics requires an issueId');
  return migrationService.listMigrationRunsForIssue(issueId);
});

// Invoked by the attachment watcher on every issue view. Atomically CLAIMS a
// stale RUNNING migration the caller should auto-resume, or returns null if
// there is nothing to recover. The claim is a compare-and-swap, so calling this
// on every poll cycle and from every open tab is safe — only one caller can
// ever win a given run.
resolver.define('recoverStaleMigration', async (req) => {
  const { issueId } = req.payload as { issueId: string };
  if (!issueId) throw new Error('recoverStaleMigration requires an issueId');
  // Claiming a run mutates it (items are reset to PENDING), so it is gated on
  // an authenticated user like every other mutating step of the pipeline.
  requireAccountId(req.context);
  return migrationService.recoverStaleRun(issueId);
});

resolver.define('resolveIssueContext', async (req) => {
  const { issueIdOrKey } = req.payload as { issueIdOrKey: string };
  if (!issueIdOrKey) throw new Error('resolveIssueContext requires issueIdOrKey');

  // Use asApp() so this works for unlicensed JSM customers who cannot call the API themselves.
  // JSM's portalRequestDetailPanel context only exposes the issue key (e.g. "SUP-1"), not the
  // numeric id, so resolve it here to the same numeric id the agent-side issue panel uses —
  // otherwise attachments recorded from the two surfaces would key on different issueId formats.
  const response = await api.asApp().requestJira(route`/rest/api/3/issue/${issueIdOrKey}?fields=project`);
  if (!response.ok) {
    throw new Error(`Failed to fetch issue ${issueIdOrKey}`);
  }
  const data = await response.json();
  return { issueId: data.id as string, projectId: data.fields?.project?.id as string };
});

resolver.define('migrateSessionOnBackend', async (req) => {
  const { sessionId, issueId, projectId } = req.payload as {
    sessionId: string;
    issueId: string;
    projectId: string;
  };
  const actorAccountId = requireAccountId(req.context);
  const cloudId = req.context.cloudId;
  if (!cloudId) throw new Error('Could not resolve cloudId from context');

  return migrationService.migrateSessionOnBackend({
    sessionId,
    issueId,
    projectId,
    actorAccountId,
    cloudId,
  });
});

resolver.define('forceRecoverSessionMigration', async (req) => {
  const { sessionId } = req.payload as { sessionId: string };
  if (!sessionId) throw new Error('forceRecoverSessionMigration requires a sessionId');
  requireAccountId(req.context);
  return migrationService.forceRecoverSessionMigration(sessionId);
});

export const handler = resolver.getDefinitions();
