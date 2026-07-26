import { AttachmentStorageProvider } from './AttachmentStorageProvider';
import { S3StorageProvider } from './S3StorageProvider';
import { StorageNotConfiguredError } from './StorageNotConfiguredError';
import {
  getStorageMode,
  getInstanceCredentials,
  getInstanceBucketStatus,
  getProjectCredentials,
  getProjectBucketStatus,
} from '../services/storageConfigService';

const providerCache = new Map<string, AttachmentStorageProvider>();

export async function getStorageProvider(ctx: { projectId: string }): Promise<AttachmentStorageProvider> {
  const mode = await getStorageMode();

  if (mode === 'INSTANCE') {
    if (providerCache.has('INSTANCE')) {
      return providerCache.get('INSTANCE')!;
    }
    const creds = await getInstanceCredentials();
    const bucketStatus = await getInstanceBucketStatus();
    
    if (!creds || !bucketStatus || bucketStatus.status !== 'PROVISIONED') {
      throw new StorageNotConfiguredError('Instance storage is not fully configured or provisioned.');
    }
    
    const provider = new S3StorageProvider(creds, bucketStatus.name);
    providerCache.set('INSTANCE', provider);
    return provider;
  } else {
    const cacheKey = `PROJECT_${ctx.projectId}`;
    if (providerCache.has(cacheKey)) {
      return providerCache.get(cacheKey)!;
    }
    
    const creds = await getProjectCredentials(ctx.projectId);
    const bucketStatus = await getProjectBucketStatus(ctx.projectId);
    
    if (!creds || !bucketStatus || bucketStatus.status !== 'PROVISIONED') {
      throw new StorageNotConfiguredError(`Project storage is not fully configured or provisioned for project ${ctx.projectId}.`);
    }
    
    const provider = new S3StorageProvider(creds, bucketStatus.name);
    providerCache.set(cacheKey, provider);
    return provider;
  }
}

export * from './AttachmentStorageProvider';
export { ObjectNotFoundError } from './ObjectNotFoundError';
export { StorageNotConfiguredError } from './StorageNotConfiguredError';
