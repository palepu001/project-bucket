import {
  S3Client,
  CreateBucketCommand,
  PutPublicAccessBlockCommand,
  PutBucketEncryptionCommand,
  PutBucketCorsCommand,
} from '@aws-sdk/client-s3';
import { createHash } from 'crypto';
import { StorageCredentials } from './storageConfigService';

const DEFAULT_FORGE_CUSTOM_UI_ORIGINS = ['https://*.cdn.prod.atlassian-dev.net'];

function allowedCorsOrigins(): string[] {
  const configured = process.env.PROJECT_BUCKET_CUSTOM_UI_ORIGINS;
  if (!configured) return DEFAULT_FORGE_CUSTOM_UI_ORIGINS;

  const origins = configured
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  return origins.length > 0 ? origins : DEFAULT_FORGE_CUSTOM_UI_ORIGINS;
}

function generateShortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').substring(0, 8);
}

export function generateInstanceBucketName(cloudId: string): string {
  const shortCloudId = cloudId.substring(0, 8);
  const hash = generateShortHash(`instance-${cloudId}`);
  return `pb-${shortCloudId}-${hash}`.toLowerCase();
}

export function generateProjectBucketName(cloudId: string, projectKey: string): string {
  const shortCloudId = cloudId.substring(0, 8);
  const hash = generateShortHash(`project-${cloudId}-${projectKey}`);
  return `pb-${shortCloudId}-${projectKey.toLowerCase()}-${hash}`.toLowerCase();
}

export async function provisionBucket(bucketName: string, creds: StorageCredentials): Promise<void> {
  const s3 = new S3Client({
    region: creds.region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
    },
  });

  try {
    await s3.send(new CreateBucketCommand({ Bucket: bucketName }));
  } catch (error: any) {
    if (error.name !== 'BucketAlreadyOwnedByYou' && error.name !== 'BucketAlreadyExists') {
      throw error;
    }
  }

  await s3.send(
    new PutPublicAccessBlockCommand({
      Bucket: bucketName,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    })
  );

  await s3.send(
    new PutBucketEncryptionCommand({
      Bucket: bucketName,
      ServerSideEncryptionConfiguration: {
        Rules: [
          {
            ApplyServerSideEncryptionByDefault: {
              SSEAlgorithm: 'AES256',
            },
          },
        ],
      },
    })
  );

  await s3.send(
    new PutBucketCorsCommand({
      Bucket: bucketName,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedHeaders: ['*'],
            AllowedMethods: ['PUT', 'GET', 'HEAD'],
            AllowedOrigins: allowedCorsOrigins(),
            ExposeHeaders: ['ETag', 'x-amz-checksum-sha256'],
            MaxAgeSeconds: 3000,
          },
        ],
      },
    })
  );
}
