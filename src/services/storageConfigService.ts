import { kvs as storage } from '@forge/kvs';

export type StorageMode = 'INSTANCE' | 'PROJECT';

export interface StorageCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

export interface RedactedCredentials {
  configured: boolean;
  region?: string;
  accessKeyIdLast4?: string;
  lastValidatedAt?: string;
}

export interface BucketStatus {
  name: string;
  status: 'PENDING' | 'PROVISIONED' | 'ERROR';
  provisionedAt?: string;
  lastError?: string;
}

// Keys
const MODE_KEY = 'storage:mode';
const CRED_INSTANCE_KEY = 'storage:creds:instance';
const BUCKET_INSTANCE_KEY = 'storage:bucket:instance';
const CLOUD_ID_KEY = 'storage:cloudId';

const getProjectCredKey = (projectId: string) => `storage:creds:project:${projectId}`;
const getProjectBucketKey = (projectId: string) => `storage:bucket:project:${projectId}`;

export async function getStorageMode(): Promise<StorageMode> {
  const mode = await storage.get(MODE_KEY);
  return (mode as StorageMode) || 'INSTANCE';
}

export async function setStorageMode(mode: StorageMode): Promise<void> {
  await storage.set(MODE_KEY, mode);
}

export async function getCloudId(): Promise<string | null> {
  const val = await storage.get(CLOUD_ID_KEY);
  return val ? String(val) : null;
}

export async function setCloudId(cloudId: string): Promise<void> {
  await storage.set(CLOUD_ID_KEY, cloudId);
}

// --- Credentials ---

export async function setInstanceCredentials(creds: StorageCredentials): Promise<void> {
  await storage.setSecret(CRED_INSTANCE_KEY, creds);
}

export async function getInstanceCredentials(): Promise<StorageCredentials | null> {
  const creds = await storage.getSecret(CRED_INSTANCE_KEY);
  return creds ? (creds as StorageCredentials) : null;
}

export async function getRedactedInstanceCredentials(): Promise<RedactedCredentials> {
  const creds = await getInstanceCredentials();
  if (!creds) return { configured: false };
  return {
    configured: true,
    region: creds.region,
    accessKeyIdLast4: creds.accessKeyId.slice(-4),
  };
}

export async function setProjectCredentials(projectId: string, creds: StorageCredentials): Promise<void> {
  await storage.setSecret(getProjectCredKey(projectId), creds);
}

export async function getProjectCredentials(projectId: string): Promise<StorageCredentials | null> {
  const creds = await storage.getSecret(getProjectCredKey(projectId));
  return creds ? (creds as StorageCredentials) : null;
}

export async function getRedactedProjectCredentials(projectId: string): Promise<RedactedCredentials> {
  const creds = await getProjectCredentials(projectId);
  if (!creds) return { configured: false };
  return {
    configured: true,
    region: creds.region,
    accessKeyIdLast4: creds.accessKeyId.slice(-4),
  };
}

// --- Bucket Status ---

export async function setInstanceBucketStatus(status: BucketStatus): Promise<void> {
  await storage.set(BUCKET_INSTANCE_KEY, status);
}

export async function getInstanceBucketStatus(): Promise<BucketStatus | null> {
  const status = await storage.get(BUCKET_INSTANCE_KEY);
  return status ? (status as BucketStatus) : null;
}

export async function setProjectBucketStatus(projectId: string, status: BucketStatus): Promise<void> {
  await storage.set(getProjectBucketKey(projectId), status);
}

export async function getProjectBucketStatus(projectId: string): Promise<BucketStatus | null> {
  const status = await storage.get(getProjectBucketKey(projectId));
  return status ? (status as BucketStatus) : null;
}
