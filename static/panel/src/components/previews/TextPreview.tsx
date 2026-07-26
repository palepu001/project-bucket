import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup';
import oneLight from 'react-syntax-highlighter/dist/esm/styles/prism/one-light';
import { useTextContent } from '../../hooks/useTextContent';
import { LoadingState, ErrorState } from '../States';

SyntaxHighlighter.registerLanguage('json', json);
SyntaxHighlighter.registerLanguage('yaml', yaml);
SyntaxHighlighter.registerLanguage('markdown', markdown);
SyntaxHighlighter.registerLanguage('markup', markup);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  md: 'markdown',
  xml: 'markup',
  html: 'markup',
  htm: 'markup',
};

export function TextPreview({ attachmentId, extension }: { attachmentId: string; extension: string })  {
  const { text, loading, error } = useTextContent(attachmentId);

  if (loading) return <LoadingState />;
  if (error || text === null) return <ErrorState message={error ?? 'Unable to load file'} onRetry={() => location.reload()} />;

  const language = LANGUAGE_BY_EXTENSION[extension.toLowerCase()];

  // txt / log (and anything without a registered grammar) render as plain,
  // line-numbered text rather than guessing at a language.
  if (!language) {
    return (
      <pre className="pb-plain-text-preview">
        <code>{text}</code>
      </pre>
    );
  }

  return (
    <SyntaxHighlighter language={language} style={oneLight} showLineNumbers wrapLongLines>
      {text}
    </SyntaxHighlighter>
  );
}
