import { useEffect, useState } from 'react';
import { invoke } from '@forge/bridge';

interface TextContentState {
  text: string | null;
  loading: boolean;
  error: string | null;
}

// Fetches text file content through the backend resolver rather than directly
// from the presigned S3 URL. This avoids CORS issues (storage backend
// presigned URLs do not include Access-Control-Allow-Origin headers) and
// works regardless of the connect-src CSP.
export function useTextContent(attachmentId: string | null, maxBytes = 2_000_000): TextContentState {
  const [state, setState] = useState<TextContentState>({ text: null, loading: true, error: null });

  useEffect(() => {
    if (!attachmentId) return;
    let cancelled = false;
    setState({ text: null, loading: true, error: null });

    (invoke<{ dataUrl?: string; error?: string }>('getFileContent', { attachmentId }) as Promise<{ dataUrl?: string; error?: string }>)
      .then((result) => {
        if (cancelled) return;
        if (result.error === 'too-large') {
          throw new Error('File is too large to preview inline — download it instead.');
        }
        if (result.error === 'not-found') {
          throw new Error('File is no longer available in storage.');
        }
        if (!result.dataUrl) {
          throw new Error('Unexpected response from file content resolver.');
        }
        // Decode the base64 data URL back to text, supporting UTF-8.
        const base64 = result.dataUrl.split(',')[1];
        const binString = atob(base64);
        const bytes = new Uint8Array(binString.length);
        for (let i = 0; i < binString.length; i++) {
          bytes[i] = binString.charCodeAt(i);
        }
        const text = new TextDecoder().decode(bytes);
        setState({ text, loading: false, error: null });
      })
      .catch((error) => {
        if (!cancelled) {
          setState({ text: null, loading: false, error: error instanceof Error ? error.message : String(error) });
        }
      });

    return () => { cancelled = true; };
  }, [attachmentId, maxBytes]);

  return state;
}
