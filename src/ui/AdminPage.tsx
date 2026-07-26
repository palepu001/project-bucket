import React, { useState, useEffect } from 'react';
import ForgeReconciler, {
  Heading,
  Text,
  Textfield,
  Toggle,
  Button,
  FormSection,
  FormFooter,
  SectionMessage,
  Stack,
  Strong,
  Badge,
  Label,
} from '@forge/react';
import { invoke } from '@forge/bridge';

const AdminPage = () => {
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<'INSTANCE' | 'PROJECT'>('INSTANCE');
  const [bucketStatus, setBucketStatus] = useState<any>(null);
  const [message, setMessage] = useState<{ text: string; type: 'information' | 'success' | 'warning' | 'error' } | null>(null);

  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [region, setRegion] = useState('');

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const data: any = await invoke('getSettings');
      setMode(data.mode);
      setBucketStatus(data.bucketStatus);
    } catch (e: any) {
      setMessage({ text: `Failed to load settings: ${e.message}`, type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const onModeChange = async (newMode: boolean) => {
    const val = newMode ? 'PROJECT' : 'INSTANCE';
    await invoke('setMode', { mode: val });
    setMode(val);
    setMessage({ text: 'Storage mode updated.', type: 'success' });
  };

  const onSubmitCredentials = async () => {
    try {
      await invoke('saveCredentials', { accessKeyId, secretAccessKey, region });
      setMessage({ text: 'Credentials saved.', type: 'success' });
      await loadSettings();
    } catch (e: any) {
      setMessage({ text: `Failed to save credentials: ${e.message}`, type: 'error' });
    }
  };

  const onProvision = async () => {
    try {
      const res: any = await invoke('provision');
      setMessage({ text: `Bucket provisioned: ${res.bucketName}`, type: 'success' });
      await loadSettings();
    } catch (e: any) {
      setMessage({ text: e.message, type: 'error' });
    }
  };

  const onTestConnection = async () => {
    try {
      const res: any = await invoke('testConnection');
      if (res.success) {
        setMessage({ text: 'Connection test passed.', type: 'success' });
      } else {
        setMessage({ text: `Connection test failed: ${res.error}`, type: 'error' });
      }
    } catch (e: any) {
      setMessage({ text: `Connection test failed: ${e.message}`, type: 'error' });
    }
  };

  if (loading) return <Text>Loading...</Text>;

  return (
    <Stack space="space.200">
      <Heading size="large">Project Bucket Storage Settings</Heading>
      <Text>Configure the S3 backend for Project Bucket attachment storage.</Text>
      
      {message && <SectionMessage appearance={message.type}>{message.text}</SectionMessage>}

      <Stack space="space.100">
        <Heading size="medium">Storage Allocation</Heading>
        <Toggle
          id="mode-toggle"
          label="Allocate storage per project (Project Mode)"
          isChecked={mode === 'PROJECT'}
          onChange={(e) => onModeChange(e.target.checked ?? false)}
        />
        <Text>
          {mode === 'INSTANCE'
            ? 'Instance Mode: All projects share a single S3 bucket configured below.'
            : 'Project Mode: Each project admin will configure their own S3 bucket.'}
        </Text>
      </Stack>

      {mode === 'INSTANCE' && (
        <Stack space="space.200">
          <FormSection>
            <Heading size="medium">Instance S3 Credentials</Heading>
            <Label labelFor="accessKeyId">Access Key ID</Label>
            <Textfield name="accessKeyId" id="accessKeyId" value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} />
            <Label labelFor="secretAccessKey">Secret Access Key</Label>
            <Textfield name="secretAccessKey" id="secretAccessKey" type="password" value={secretAccessKey} onChange={(e) => setSecretAccessKey(e.target.value)} />
            <Label labelFor="region">AWS Region</Label>
            <Textfield name="region" id="region" value={region} onChange={(e) => setRegion(e.target.value)} />
          </FormSection>
          <FormFooter>
            <Button appearance="primary" onClick={onSubmitCredentials}>Save Credentials</Button>
            <Button onClick={onTestConnection}>Test Connection</Button>
            <Button onClick={onProvision}>Provision Bucket</Button>
          </FormFooter>
        </Stack>
      )}

      {mode === 'INSTANCE' && (
        <Stack space="space.100">
          <Heading size="medium">Bucket Status</Heading>
          {bucketStatus ? (
            <Text>
              Status: <Badge>{bucketStatus.status}</Badge> Name: <Strong>{bucketStatus.name}</Strong>
            </Text>
          ) : (
            <Text>Not provisioned yet.</Text>
          )}
        </Stack>
      )}

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
