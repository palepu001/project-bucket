/**
 * Mock Malware Scanner
 * 
 * A dummy implementation of the MalwareScanner interface for development
 * and testing environments. It always passes the file.
 */
import type { MalwareScanner, ValidationResult } from '../types';

export class MockScanner implements MalwareScanner {
  public readonly engineName = 'MockScanner';

  /**
   * Simulates a malware scan.
   * Always logs the invocation and returns a passing result.
   * 
   * @param file The file object to "scan".
   * @returns A promise resolving to a successful validation result.
   */
  public async scan(_file: File): Promise<ValidationResult> {
    // Leave an audit trail for observability in dev environments
    console.log('[ProjectBucket] MockScanner: scan invoked (always passes)');
    
    return { passed: true };
  }
}

export default MockScanner;
