import { useTextContent } from '../../hooks/useTextContent';
import { parseCsv } from '../../utils/csv';
import { LoadingState, ErrorState } from '../States';

export function CsvPreview({ attachmentId }: { attachmentId: string })  {
  const { text, loading, error } = useTextContent(attachmentId);

  if (loading) return <LoadingState />;
  if (error || text === null) return <ErrorState message={error ?? 'Unable to load file'} onRetry={() => location.reload()} />;

  const rows = parseCsv(text);
  if (rows.length === 0) return <p className="pb-state-detail">This CSV file is empty.</p>;

  const [header, ...body] = rows;

  return (
    <div className="pb-csv-preview">
      <table>
        <thead>
          <tr>
            {header.map((cell, index) => (
              <th key={index}>{cell || `Column ${index + 1}`}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
