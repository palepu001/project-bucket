import { useEffect, useState } from 'react';
import * as api from './api/resolvers';
import { LoadingState, ErrorState } from './components/States';

export function Router() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function route() {
      try {
        const urlParams = new URLSearchParams(window.location.search);
        const attachmentId = urlParams.get('attachmentId');
        
        if (!attachmentId) {
          throw new Error('No attachmentId provided in the URL.');
        }

        const result = await api.getDownloadUrl(attachmentId);
        
        if (result.unavailable || !result.url) {
          throw new Error('File is unavailable or could not be found.');
        }

        // Redirect directly to the signed URL
        window.location.href = result.url;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
    
    route();
  }, []);

  if (error) {
    return <ErrorState message={error} onRetry={() => location.reload()} />;
  }

  return <LoadingState />;
}
