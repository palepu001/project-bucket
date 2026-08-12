import React, { useState, useEffect } from 'react';
import ForgeReconciler, {
  Heading,
  Text,
  Textfield,
  Button,
  FormSection,
  FormFooter,
  SectionMessage,
  Stack,
  Strong,
  Badge,
  Label,
  Modal,
  ModalTransition,
  ModalBody,
  ModalHeader,
  ModalTitle,
  Inline,
  Box,
  Toggle,
} from '@forge/react';
import { invoke } from '@forge/bridge';

const AdminPage = () => {
  const [loading, setLoading] = useState(true);
  const [credentials, setCredentials] = useState<any>(null);
  const [bucketStatus, setBucketStatus] = useState<any>(null);
  // keepJiraAttachments: when true the native Jira copy is NOT deleted after
  // a successful S3 migration. Loaded from KVS; defaults to false (delete).
  const [keepJiraAttachments, setKeepJiraAttachments] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: 'information' | 'success' | 'warning' | 'error' } | null>(null);

  // Modal State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [region, setRegion] = useState('');

  // Action pending states
  const [testingConnection, setTestingConnection] = useState(false);
  const [provisioning, setProvisioning] = useState(false);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const data: any = await invoke('getSettings');
      setCredentials(data.credentials);
      setBucketStatus(data.bucketStatus);
      // Backend returns false when unset, so this correctly initialises to
      // the "delete" default for installs that have never touched the toggle.
      setKeepJiraAttachments(data.keepJiraAttachments ?? false);
    } catch (e: any) {
      setMessage({ text: `Failed to load settings: ${e.message}`, type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const onSubmitCredentials = async () => {
    try {
      await invoke('saveCredentials', { accessKeyId, secretAccessKey, region });
      setMessage({ text: 'AWS Credentials saved successfully.', type: 'success' });
      setIsModalOpen(false);
      setAccessKeyId('');
      setSecretAccessKey('');
      setRegion('');
      await loadSettings();
    } catch (e: any) {
      setMessage({ text: `Failed to save credentials: ${e.message}`, type: 'error' });
    }
  };

  const onTestConnection = async () => {
    setTestingConnection(true);
    try {
      const res: any = await invoke('testConnection');
      if (res.success) {
        setMessage({ text: 'Connection test passed successfully.', type: 'success' });
      } else {
        setMessage({ text: `Connection test failed: ${res.error}`, type: 'error' });
      }
    } catch (e: any) {
      setMessage({ text: `Connection test failed: ${e.message}`, type: 'error' });
    } finally {
      setTestingConnection(false);
    }
  };

  const onProvisionInstance = async () => {
    setProvisioning(true);
    try {
      const res: any = await invoke('provision');
      setMessage({ text: `Global S3 bucket provisioned: ${res.bucketName}`, type: 'success' });
      await loadSettings();
    } catch (e: any) {
      setMessage({ text: e.message, type: 'error' });
    } finally {
      setProvisioning(false);
    }
  };

  // Persists the toggle change immediately so the admin doesn't need to
  // submit a form — the setting takes effect on the next migration run.
  const onToggleKeepJira = async (e: any) => {
    const newValue = e.target.checked;
    setKeepJiraAttachments(newValue);
    try {
      await invoke('saveKeepJiraAttachments', { keepJiraAttachments: newValue });
      setMessage({
        text: newValue
          ? 'Jira attachments will be kept after migration.'
          : 'Jira attachments will be deleted after migration.',
        type: 'success',
      });
    } catch (ex: any) {
      // Revert the optimistic local update if the save failed.
      setKeepJiraAttachments(!newValue);
      setMessage({ text: `Failed to save setting: ${ex.message}`, type: 'error' });
    }
  };

  if (loading) return <Text>Loading...</Text>;

  return (
    <Stack space="space.200">
      <Text>Configure and manage S3-compatible backend storage for all Jira attachments.</Text>
      
      {message && <SectionMessage appearance={message.type}>{message.text}</SectionMessage>}

      {/* S3 Credentials Configuration Panel */}
      <Stack space="space.100">
        <Heading size="medium">AWS S3 Connection</Heading>
        <Inline space="space.100" alignBlock="center">
          {credentials?.configured ? (
            <Badge appearance="added">CONNECTED</Badge>
          ) : (
            <Badge appearance="important">NOT CONNECTED</Badge>
          )}
          {credentials?.region && (
            <Text>Region: <Strong>{credentials.region}</Strong></Text>
          )}
          {credentials?.accessKeyIdLast4 && (
            <Text>Access Key ending in: <Strong>****{credentials.accessKeyIdLast4}</Strong></Text>
          )}
        </Inline>
        <Inline space="space.100">
          <Button onClick={() => setIsModalOpen(true)}>Configure AWS S3 Connection</Button>
          {credentials?.configured && (
            <Button onClick={onTestConnection} isDisabled={testingConnection}>
              {testingConnection ? 'Testing...' : 'Test Connection'}
            </Button>
          )}
        </Inline>
      </Stack>

      {/* Shared Global Bucket Details */}
      <Stack space="space.100">
        <Heading size="medium">Global S3 Bucket Status</Heading>
        {bucketStatus ? (
          <Stack space="space.100">
            <Text>
              Status: <Badge appearance={bucketStatus.status === 'PROVISIONED' ? 'added' : 'neutral'}>{bucketStatus.status}</Badge> Name: <Strong>{bucketStatus.name}</Strong>
            </Text>
            {bucketStatus.provisionedAt && (
              <Text>Provisioned At: {new Date(bucketStatus.provisionedAt).toLocaleString()}</Text>
            )}
          </Stack>
        ) : (
          <Text>Not provisioned yet.</Text>
        )}
        {credentials?.configured && (
          <FormFooter>
            <Button appearance="primary" onClick={onProvisionInstance} isDisabled={provisioning}>
              {provisioning ? 'Provisioning...' : (bucketStatus ? 'Re-provision Bucket' : 'Provision Bucket')}
            </Button>
          </FormFooter>
        )}
      </Stack>

      {/* Credentials Setup Modal */}
      <ModalTransition>
        {isModalOpen && (
          <Modal onClose={() => setIsModalOpen(false)}>
            <ModalHeader>
              <ModalTitle>Configure AWS S3 Connection</ModalTitle>
            </ModalHeader>
            <ModalBody>
              <Box padding="space.300">
                <FormSection>
                  <Text>Provide S3-compatible credentials. The credentials will be stored securely and used to manage the global bucket and attachments.</Text>
                  <Label labelFor="accessKeyId">Access Key ID</Label>
                  <Textfield name="accessKeyId" id="accessKeyId" value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} />
                  <Label labelFor="secretAccessKey">Secret Access Key</Label>
                  <Textfield name="secretAccessKey" id="secretAccessKey" type="password" value={secretAccessKey} onChange={(e) => setSecretAccessKey(e.target.value)} />
                  <Label labelFor="region">AWS Region</Label>
                  <Textfield name="region" id="region" value={region} onChange={(e) => setRegion(e.target.value)} />
                </FormSection>
              </Box>
            </ModalBody>
            <FormFooter>
              <Button appearance="subtle" onClick={() => setIsModalOpen(false)}>Cancel</Button>
              <Button appearance="primary" onClick={onSubmitCredentials}>Save Connection Settings</Button>
            </FormFooter>
          </Modal>
        )}
      </ModalTransition>

      {/* Migration Behaviour */}
      <Stack space="space.100">
        <Heading size="medium">Migration Behaviour</Heading>
        <Text>Control what happens to the original Jira attachment after it is successfully uploaded to S3.</Text>
        <Inline space="space.100" alignBlock="center">
          <Toggle
            id="keepJiraAttachments"
            isChecked={keepJiraAttachments}
            onChange={onToggleKeepJira}
          />
          <Label labelFor="keepJiraAttachments">
            Keep original Jira attachments after migration
          </Label>
        </Inline>
        <Text>
          {keepJiraAttachments
            ? 'Jira\'s native copy is preserved. Both the S3 copy and the original Jira attachment will remain visible.'
            : 'Jira\'s native copy is deleted once S3 confirms the upload. This saves Jira storage space (default).'}
        </Text>
      </Stack>

      <Stack space="space.100">
        <Heading size="medium">Danger Zone</Heading>
        <Button appearance="danger" onClick={async () => {
            try {
              await invoke('purgeLegacy');
              setMessage({ text: 'Legacy data purged (no-op).', type: 'success' });
            } catch (e: any) {
              setMessage({ text: `Failed to purge: ${e.message}`, type: 'error' });
            }
        }}>
          Purge Legacy Storage Data
        </Button>
      </Stack>
    </Stack>
  );
};

ForgeReconciler.render(<AdminPage />);
