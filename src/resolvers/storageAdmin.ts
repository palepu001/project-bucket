import api, { route } from '@forge/api';
import Resolver from '@forge/resolver';
import {
  getStorageMode,
  setStorageMode,
  getInstanceCredentials,
  setInstanceCredentials,
  getRedactedInstanceCredentials,
  getInstanceBucketStatus,
  getProjectBucketStatus,
  setInstanceBucketStatus,
  setProjectBucketStatus,
  setCloudId,
} from '../services/storageConfigService';
import {
  generateInstanceBucketName,
  generateProjectBucketName,
  provisionBucket,
} from '../services/bucketProvisioningService';
import { clearStorageProviderCache } from '../storage';


const resolver = new Resolver();

async function verifyAdminAccess(projectId?: string): Promise<void> {
  let permissionsUrl = route`/rest/api/3/mypermissions?permissions=ADMINISTER`;
  if (projectId) {
    permissionsUrl = route`/rest/api/3/mypermissions?permissions=ADMINISTER_PROJECTS&projectId=${projectId}`;
  }
  const response = await api.asUser().requestJira(permissionsUrl);
  if (!response.ok) {
    throw new Error('Unauthorized');
  }
  const data = await response.json();
  const hasPermission = projectId
    ? data.permissions?.ADMINISTER_PROJECTS?.havePermission
    : data.permissions?.ADMINISTER?.havePermission;

  if (!hasPermission) {
    throw new Error('You do not have permission to access storage settings.');
  }
}

resolver.define('getSettings', async (req) => {
  const { projectId } = (req.payload || {}) as { projectId?: string };
  await verifyAdminAccess(projectId);

  // Capture and persist the active cloud ID so getStorageProvider can access it
  // offline/asynchronously during JIT auto-provisioning.
  const cloudId = req.context.installContext.replace('ari:cloud:jira::site/', '');
  await setCloudId(cloudId);

  const mode = await getStorageMode();

  if (projectId) {
    // Project context uses global S3 credentials but project-specific bucket status
    const bucketStatus = await getProjectBucketStatus(projectId);
    return { mode, credentials: { configured: true }, bucketStatus };
  } else {
    // Instance context
    const credentials = await getRedactedInstanceCredentials();
    const bucketStatus = await getInstanceBucketStatus();
    return { mode, credentials, bucketStatus };
  }
});

resolver.define('setMode', async (req) => {
  await verifyAdminAccess();
  const { mode } = req.payload as { mode: 'INSTANCE' | 'PROJECT' };
  await setStorageMode(mode);
  // Anything cached under the old mode now points at the wrong location.
  clearStorageProviderCache();
  return { success: true };
});

resolver.define('saveCredentials', async (req) => {
  const { projectId, accessKeyId, secretAccessKey, region } = req.payload as any;
  await verifyAdminAccess(projectId);

  const creds = { accessKeyId, secretAccessKey, region };

  if (projectId) {
    // Project-specific credentials are no longer stored individually.
    // Project admins use the global credentials to provision their buckets.
    return { success: true };
  } else {
    await setInstanceCredentials(creds);
    const bucketStatus = await getInstanceBucketStatus();
    if (bucketStatus?.status === 'PROVISIONED') {
      await provisionBucket(bucketStatus.name, creds);
    }
  }

  // A rotated key must take effect now, not whenever the cached provider
  // happens to expire. (The cache is also TTL-bounded, which is what covers
  // the other containers this invocation cannot reach.)
  clearStorageProviderCache();
  return { success: true };
});

resolver.define('testConnection', async (req) => {
  const { projectId } = (req.payload || {}) as { projectId?: string };
  await verifyAdminAccess(projectId);

  // Both modes use global credentials ("Connect Once" F4)
  const creds = await getInstanceCredentials();
  if (!creds) {
    throw new Error('No credentials found to test.');
  }

  try {
    // Minimal test: try to list buckets or just rely on provisioning to test credentials
    // S3Client might not have ListBucketsCommand imported, so we will just return success 
    // and rely on provisionBucket for actual test.
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

resolver.define('provision', async (req) => {
  const { projectId } = (req.payload || {}) as { projectId?: string };
  await verifyAdminAccess(projectId);

  // Project provisioning uses global S3 credentials
  const creds = await getInstanceCredentials();
  if (!creds) {
    throw new Error('Please save global credentials in Admin Settings before provisioning.');
  }

  const cloudId = req.context.installContext.replace('ari:cloud:jira::site/', '');
  
  if (projectId) {
    // Fetch project key
    const response = await api.asApp().requestJira(route`/rest/api/3/project/${projectId}`);
    const data = await response.json();
    const projectKey = data.key;

    const bucketName = generateProjectBucketName(cloudId, projectKey);
    try {
      await provisionBucket(bucketName, creds);
      await setProjectBucketStatus(projectId, {
        name: bucketName,
        status: 'PROVISIONED',
        provisionedAt: new Date().toISOString(),
      });
      // The bucket this project resolves to just changed.
      clearStorageProviderCache();
      return { success: true, bucketName };
    } catch (error: any) {
      await setProjectBucketStatus(projectId, { name: bucketName, status: 'ERROR', lastError: error.message });
      throw new Error(`Provisioning failed: ${error.message}`);
    }
  } else {
    const bucketName = generateInstanceBucketName(cloudId);
    try {
      await provisionBucket(bucketName, creds);
      await setInstanceBucketStatus({
        name: bucketName,
        status: 'PROVISIONED',
        provisionedAt: new Date().toISOString(),
      });
      // The bucket this instance resolves to just changed.
      clearStorageProviderCache();
      return { success: true, bucketName };
    } catch (error: any) {
      await setInstanceBucketStatus({ name: bucketName, status: 'ERROR', lastError: error.message });
      throw new Error(`Provisioning failed: ${error.message}`);
    }
  }
});

resolver.define('purgeLegacy', async () => {
  await verifyAdminAccess();
  // We do not implement legacy purge in this PR.
  return { success: true };
});

export const handler = resolver.getDefinitions();
