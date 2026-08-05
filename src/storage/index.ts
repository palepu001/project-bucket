import { AttachmentStorageProvider } from './AttachmentStorageProvider';
import { S3StorageProvider } from './S3StorageProvider';
import { StorageNotConfiguredError } from './StorageNotConfiguredError';
import {
  getStorageMode,
  getInstanceCredentials,
  getInstanceBucketStatus,
  getProjectBucketStatus,
  setProjectBucketStatus,
  getCloudId,
} from '../services/storageConfigService';
import api, { route } from '@forge/api';
import {
  generateProjectBucketName,
  provisionBucket,
} from '../services/bucketProvisioningService';

// Providers are cached because building one costs two KVS reads (mode +
// credentials) and an S3Client construction, and a single gallery load asks for
// one per attachment.
//
// The cache is TIME-BOUNDED rather than permanent. An admin who rotates
// credentials or re-provisions a bucket must not keep hitting the old location
// from a warm container, and Forge gives no cross-container invalidation
// signal, so a short TTL is what actually bounds the staleness everywhere.
// clearStorageProviderCache() additionally makes the change instant on the
// container that served the admin's own save.
const PROVIDER_TTL_MS = 60_000;

interface CacheEntry {
  provider: AttachmentStorageProvider;
  expiresAt: number;
}

const providerCache = new Map<string, CacheEntry>();

function cached(key: string): AttachmentStorageProvider | null {
  const entry = providerCache.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    providerCache.delete(key);
    return null;
  }
  return entry.provider;
}

function remember(key: string, provider: AttachmentStorageProvider): AttachmentStorageProvider {
  providerCache.set(key, { provider, expiresAt: Date.now() + PROVIDER_TTL_MS });
  return provider;
}

/**
 * Drops every cached provider. Called by the storage admin resolvers after any
 * write that changes where bytes should go (credentials, mode, provisioning),
 * so the admin's next action uses the new configuration immediately instead of
 * waiting out the TTL.
 */
export function clearStorageProviderCache(): void {
  providerCache.clear();
}

export async function getStorageProvider(ctx: { projectId: string }): Promise<AttachmentStorageProvider> {
  const mode = await getStorageMode();

  if (mode === 'INSTANCE') {
    const hit = cached('INSTANCE');
    if (hit) return hit;

    const creds = await getInstanceCredentials();
    const bucketStatus = await getInstanceBucketStatus();

    if (!creds || !bucketStatus || bucketStatus.status !== 'PROVISIONED') {
      throw new StorageNotConfiguredError('Instance storage is not fully configured or provisioned.');
    }

    return remember('INSTANCE', new S3StorageProvider(creds, bucketStatus.name));
  } else {
    const cacheKey = `PROJECT_${ctx.projectId}`;
    const hit = cached(cacheKey);
    if (hit) return hit;

    // PROJECT mode uses the GLOBAL S3 credentials ("Connect Once" PRD F4)
    const creds = await getInstanceCredentials();
    if (!creds) {
      throw new StorageNotConfiguredError('Global S3 credentials are not configured.');
    }

    let bucketStatus = await getProjectBucketStatus(ctx.projectId);

    // If the project's dedicated bucket has not been provisioned yet, automatically
    // provision it on-the-fly (just-in-time F1 "no manual setup per project")
    if (!bucketStatus || bucketStatus.status !== 'PROVISIONED') {
      console.log(`[ProjectBucket] getStorageProvider: Project bucket for project ${ctx.projectId} not provisioned. Attempting JIT provisioning...`);
      try {
        const response = await api.asApp().requestJira(route`/rest/api/3/project/${ctx.projectId}`);
        if (!response.ok) {
          throw new Error(`Failed to fetch project details (HTTP ${response.status})`);
        }
        const data = await response.json();
        const projectKey = data.key;

        const savedCloudId = await getCloudId();
        if (!savedCloudId) {
          throw new Error('Active cloud ID is not stored. Please visit Admin Settings first.');
        }
        const bucketName = generateProjectBucketName(savedCloudId, projectKey);

        await provisionBucket(bucketName, creds);
        bucketStatus = {
          name: bucketName,
          status: 'PROVISIONED',
          provisionedAt: new Date().toISOString(),
        };
        await setProjectBucketStatus(ctx.projectId, bucketStatus);
        console.log(`[ProjectBucket] getStorageProvider: Successfully JIT provisioned bucket "${bucketName}" for project ${ctx.projectId}`);
      } catch (error: any) {
        console.error(`[ProjectBucket] Failed to JIT provision project bucket for project ${ctx.projectId}:`, error);
        throw new StorageNotConfiguredError(
          `Project S3 bucket is not provisioned for project ${ctx.projectId} and JIT auto-provisioning failed: ${error.message}`
        );
      }
    }

    return remember(cacheKey, new S3StorageProvider(creds, bucketStatus.name));
  }
}

export * from './AttachmentStorageProvider';
export { ObjectNotFoundError } from './ObjectNotFoundError';
export { StorageNotConfiguredError } from './StorageNotConfiguredError';
