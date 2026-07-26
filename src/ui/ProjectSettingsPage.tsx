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
} from '@forge/react';
import { invoke, view } from '@forge/bridge';

const ProjectSettingsPage = () => {
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<'INSTANCE' | 'PROJECT'>('INSTANCE');
  const [bucketStatus, setBucketStatus] = useState<any>(null);
  const [message, setMessage] = useState<{ text: string; type: 'information' | 'success' | 'warning' | 'error' } | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);

  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [region, setRegion] = useState('');

  useEffect(() => {
    view.getContext().then((ctx: any) => {
      if (ctx && ctx.extension && ctx.extension.project) {
        setProjectId(ctx.extension.project.id);
      }
    });
  }, []);

  useEffect(() => {
    if (projectId) loadSettings();
  }, [projectId]);

  const loadSettings = async () => {
    try {
      const data: any = await invoke('getSettings', { projectId });
      setMode(data.mode);
      setBucketStatus(data.bucketStatus);
    } catch (e: any) {
      setMessage({ text: `Failed to load settings: ${e.message}`, type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const onSubmitCredentials = async () => {
    try {
      await invoke('saveCredentials', { accessKeyId, secretAccessKey, region, projectId });
      setMessage({ text: 'Credentials saved.', type: 'success' });
      await loadSettings();
    } catch (e: any) {
      setMessage({ text: `Failed to save credentials: ${e.message}`, type: 'error' });
    }
  };

  const onProvision = async () => {
    try {
      const res: any = await invoke('provision', { projectId });
      setMessage({ text: `Bucket provisioned: ${res.bucketName}`, type: 'success' });
      await loadSettings();
    } catch (e: any) {
      setMessage({ text: e.message, type: 'error' });
    }
  };

  const onTestConnection = async () => {
    try {
      const res: any = await invoke('testConnection', { projectId });
      if (res.success) {
        setMessage({ text: 'Connection test passed.', type: 'success' });
      } else {
        setMessage({ text: `Connection test failed: ${res.error}`, type: 'error' });
      }
    } catch (e: any) {
      setMessage({ text: `Connection test failed: ${e.message}`, type: 'error' });
    }
  };

  if (loading || !projectId) return <Text>Loading...</Text>;

  if (mode === 'INSTANCE') {
    return (
      <Stack space="space.200">
        <Heading size="large">Project Bucket Storage Settings</Heading>
        <SectionMessage appearance="information">
          Storage is currently allocated at the Instance level. No project-level configuration is needed.
        </SectionMessage>
      </Stack>
    );
  }

  return (
    <Stack space="space.200">
      <Heading size="large">Project Bucket Storage Settings</Heading>
      <Text>Configure the S3 backend for this project's attachment storage.</Text>
      
      {message && <SectionMessage appearance={message.type}>{message.text}</SectionMessage>}

      <Stack space="space.200">
        <FormSection>
          <Heading size="medium">Project S3 Credentials</Heading>
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
    </Stack>
  );
};

ForgeReconciler.render(<ProjectSettingsPage />);
