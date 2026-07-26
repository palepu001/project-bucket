import { useRef, useState } from 'react';
import { showFlag } from '@forge/bridge';
import { uploadFiles } from '../services/uploadService';
import { Attachment } from '../types';

export function UploadButton({
  issueId,
  projectId,
  onUploaded,
}: {
  issueId: string;
  projectId: string;
  onUploaded: (created: Attachment[]) => void;
})  {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    setBusy(true);
    try {
      const { created, failed } = await uploadFiles(files, issueId, projectId);
      if (created.length > 0) {
        onUploaded(created);
      }
      if (failed.length > 0) {
        showFlag({
          id: `pb-upload-failed-${Date.now()}`,
          title: failed.length === 1 ? 'A file failed to upload' : `${failed.length} files failed to upload`,
          type: 'error',
          description: failed.map((f) => `${f.filename}: ${f.error}`).join('; '),
          isAutoDismiss: false,
        });
      } else if (created.length > 0) {
        showFlag({
          id: `pb-upload-success-${Date.now()}`,
          title: created.length === 1 ? 'Attachment added' : `${created.length} attachments added`,
          type: 'success',
          description: 'Uploaded to Project Bucket.',
          isAutoDismiss: true,
        });
      }
    } catch (error) {
      let errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('<!DOCTYPE html>') || errorMessage.includes('<html')) {
        errorMessage = 'A network or proxy error occurred while communicating with the server. If you are using forge tunnel, this may be an issue with tunnel connectivity.';
      }
      
      showFlag({
        id: `pb-upload-error-${Date.now()}`,
        title: 'Upload failed',
        type: 'error',
        description: errorMessage,
        isAutoDismiss: false,
      });
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <>
      {/* Primary + spotlight pulse: this is the panel's headline action and
          should catch the eye the moment the issue opens. The pulse is the
          ADS onboarding treatment, so it grabs attention while still reading
          as native Jira; it stops on hover/focus (see styles.css). */}
      <button
        className="pb-button pb-button-primary pb-button-pulse"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? 'Uploading…' : '+ Add attachment'}
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(event) => handleFiles(event.target.files)}
      />
    </>
  );
}
