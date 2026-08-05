import { kvs as storage } from '@forge/kvs';

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
const CRED_INSTANCE_KEY = 'storage:creds:instance';
const BUCKET_INSTANCE_KEY = 'storage:bucket:instance';

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

// --- Bucket Status ---

export async function setInstanceBucketStatus(status: BucketStatus): Promise<void> {
  await storage.set(BUCKET_INSTANCE_KEY, status);
}

export async function getInstanceBucketStatus(): Promise<BucketStatus | null> {
  const status = await storage.get(BUCKET_INSTANCE_KEY);
  return status ? (status as BucketStatus) : null;
}
