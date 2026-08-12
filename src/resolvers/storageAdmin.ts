import api, { route } from '@forge/api';
import Resolver from '@forge/resolver';
import {
  getInstanceCredentials,
  setInstanceCredentials,
  getRedactedInstanceCredentials,
  getInstanceBucketStatus,
  setInstanceBucketStatus,
  getKeepJiraAttachments,
  setKeepJiraAttachments,
} from '../services/storageConfigService';
import {
  generateInstanceBucketName,
  provisionBucket,
} from '../services/bucketProvisioningService';
import { clearStorageProviderCache } from '../storage';

const resolver = new Resolver();

async function verifyAdminAccess(): Promise<void> {
  const permissionsUrl = route`/rest/api/3/mypermissions?permissions=ADMINISTER`;
  const response = await api.asUser().requestJira(permissionsUrl);
  if (!response.ok) {
    throw new Error('Unauthorized');
  }
  const data = await response.json();
  const hasPermission = data.permissions?.ADMINISTER?.havePermission;

  if (!hasPermission) {
    throw new Error('You do not have permission to access storage settings.');
  }
}

resolver.define('getSettings', async () => {
  await verifyAdminAccess();
  const credentials = await getRedactedInstanceCredentials();
  const bucketStatus = await getInstanceBucketStatus();
  // Read the migration behaviour setting — false (delete) is the default.
  const keepJiraAttachments = await getKeepJiraAttachments();
  return { credentials, bucketStatus, keepJiraAttachments };
});

resolver.define('saveCredentials', async (req) => {
  await verifyAdminAccess();
  const { accessKeyId, secretAccessKey, region } = req.payload as any;
  const creds = { accessKeyId, secretAccessKey, region };

  await setInstanceCredentials(creds);
  const bucketStatus = await getInstanceBucketStatus();
  if (bucketStatus?.status === 'PROVISIONED') {
    await provisionBucket(bucketStatus.name, creds);
  }

  clearStorageProviderCache();
  return { success: true };
});

resolver.define('testConnection', async () => {
  await verifyAdminAccess();
  const creds = await getInstanceCredentials();
  if (!creds) {
    throw new Error('No credentials found to test.');
  }
  return { success: true };
});

resolver.define('provision', async (req) => {
  await verifyAdminAccess();
  const creds = await getInstanceCredentials();
  if (!creds) {
    throw new Error('Please save credentials before provisioning.');
  }

  const cloudId = req.context.installContext.replace('ari:cloud:jira::site/', '');
  const bucketName = generateInstanceBucketName(cloudId);
  try {
    await provisionBucket(bucketName, creds);
    await setInstanceBucketStatus({
      name: bucketName,
      status: 'PROVISIONED',
      provisionedAt: new Date().toISOString(),
    });
    clearStorageProviderCache();
    return { success: true, bucketName };
  } catch (error: any) {
    await setInstanceBucketStatus({ name: bucketName, status: 'ERROR', lastError: error.message });
    throw new Error(`Provisioning failed: ${error.message}`);
  }
});

resolver.define('purgeLegacy', async () => {
  await verifyAdminAccess();
  return { success: true };
});

// Persists the admin's choice about whether native Jira attachments are kept
// after a successful migration. Only Jira admins may change this setting.
resolver.define('saveKeepJiraAttachments', async (req) => {
  await verifyAdminAccess();
  const { keepJiraAttachments } = req.payload as { keepJiraAttachments: boolean };
  if (typeof keepJiraAttachments !== 'boolean') {
    throw new Error('keepJiraAttachments must be a boolean');
  }
  await setKeepJiraAttachments(keepJiraAttachments);
  return { success: true };
});

export const handler = resolver.getDefinitions();
