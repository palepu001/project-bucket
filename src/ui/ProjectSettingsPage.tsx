import React, { useState, useEffect } from 'react';
import ForgeReconciler, {
  Heading,
  Text,
  Button,
  FormFooter,
  SectionMessage,
  Stack,
  Strong,
  Badge,
} from '@forge/react';
import { invoke, view } from '@forge/bridge';

const ProjectSettingsPage = () => {
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<'INSTANCE' | 'PROJECT'>('INSTANCE');
  const [bucketStatus, setBucketStatus] = useState<any>(null);
  const [message, setMessage] = useState<{ text: string; type: 'information' | 'success' | 'warning' | 'error' } | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);

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
      <Text>View and manage the dedicated S3 storage bucket for this project.</Text>
      
      {message && <SectionMessage appearance={message.type}>{message.text}</SectionMessage>}

      <Stack space="space.100">
        <Heading size="medium">Bucket Status</Heading>
        {bucketStatus ? (
          <Stack space="space.100">
            <Text>
              Status: <Badge>{bucketStatus.status}</Badge> Name: <Strong>{bucketStatus.name}</Strong>
            </Text>
            {bucketStatus.provisionedAt && (
              <Text>
                Provisioned At: {new Date(bucketStatus.provisionedAt).toLocaleString()}
              </Text>
            )}
          </Stack>
        ) : (
          <Text>Not provisioned yet. The bucket will be automatically provisioned on the first upload, or you can provision it manually below.</Text>
        )}
      </Stack>

      <FormFooter>
        <Button onClick={onTestConnection}>Test Connection</Button>
        <Button appearance="primary" onClick={onProvision}>Provision Bucket</Button>
      </FormFooter>
    </Stack>
  );
};

ForgeReconciler.render(<ProjectSettingsPage />);
