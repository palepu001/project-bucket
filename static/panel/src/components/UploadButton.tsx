import { useRef } from 'react';

// A thin file picker. All upload orchestration — validation, transfer, progress
// placeholders, flags and the gallery refresh — lives in App.handleUpload so the
// in-progress state can be surfaced as optimistic cards/rows in the gallery.
// This component only opens the OS picker and hands the chosen files up.
export function UploadButton({
  onFiles,
  busy,
}: {
  onFiles: (files: File[]) => void;
  busy: boolean;
})  {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      {/* Primary + spotlight pulse: this is the panel's headline action and
          should catch the eye the moment the issue opens. The pulse is the
          ADS onboarding treatment, so it grabs attention while still reading
          as native Jira; it stops on hover/focus (see styles.css). */}
      <button
        className="pb-button pb-button-primary pb-button-pulse pb-topbar-upload"
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
        onChange={(event) => {
          const files = event.target.files ? Array.from(event.target.files) : [];
          // Reset the input BEFORE handing off, so picking the same file again
          // later still fires onChange (the value would otherwise be unchanged).
          if (inputRef.current) inputRef.current.value = '';
          if (files.length > 0) onFiles(files);
        }}
      />
    </>
  );
}
