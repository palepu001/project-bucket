import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  AttachmentStorageProvider,
  ByteStream,
  ExistenceResult,
  UploadRequest,
  UploadTarget,
  ViewUrl,
} from './AttachmentStorageProvider';
import { mapSettledWithConcurrency } from '../util/concurrency';
import { ObjectNotFoundError } from './ObjectNotFoundError';
import { StorageCredentials } from '../services/storageConfigService';

export class S3StorageProvider implements AttachmentStorageProvider {
  private s3: S3Client;
  private bucket: string;

  constructor(creds: StorageCredentials, bucketName: string) {
    this.s3 = new S3Client({
      region: creds.region,
      credentials: {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
      },
    });
    this.bucket = bucketName;
  }

  async upload(request: UploadRequest): Promise<UploadTarget> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: request.ref,
      ContentLength: request.length,
      ContentType: request.mimeType,
      ChecksumSHA256: request.checksum,
    });

    const url = await getSignedUrl(this.s3, command, {
      expiresIn: 3600,
    });

    return {
      url,
      method: 'PUT',
      headers: {
        'x-amz-checksum-sha256': request.checksum,
      },
    };
  }

  async download(ref: string): Promise<ViewUrl> {
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: ref }));
    } catch (error: any) {
      if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
        throw new ObjectNotFoundError(ref);
      }
      throw error;
    }

    const command = new GetObjectCommand({ Bucket: this.bucket, Key: ref });
    const url = await getSignedUrl(this.s3, command, { expiresIn: 3600 });
    return { url };
  }

  async stream(ref: string): Promise<ByteStream | null> {
    try {
      const response = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: ref }));
      if (!response.Body) return null;

      const body = response.Body as unknown as ReadableStream<Uint8Array>;
      return { body, size: response.ContentLength || 0 };
    } catch (error: any) {
      if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404 || error.name === 'NoSuchKey') {
        return null;
      }
      throw error;
    }
  }

  async delete(ref: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: ref }));
  }

  async exists(refs: string[]): Promise<ExistenceResult[]> {
    const settled = await mapSettledWithConcurrency(
      refs,
      async (ref) => {
        const metadata = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: ref }));
        return { ref, metadata };
      },
      10
    );

    return settled.map((result, index): ExistenceResult => {
      const ref = refs[index];
      if (result.status === 'rejected') {
        const error = result.reason as any;
        if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404 || error.name === 'NoSuchKey') {
          return { ref, status: 'missing' };
        }
        console.warn(`[ProjectBucket] S3 existence check failed for ref "${ref}":`, result.reason);
        return { ref, status: 'error' };
      }
      const { metadata } = result.value;
      return {
        ref,
        status: 'found',
        summary: {
          ref,
          size: metadata.ContentLength || 0,
          checksum: metadata.ChecksumSHA256 || '',
          createdAt: metadata.LastModified?.toISOString(),
        },
      };
    });
  }
}
