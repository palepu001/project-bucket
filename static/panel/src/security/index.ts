// F5 — Validation Pipeline factory. Assembles the default pipeline with all
// validators in the correct execution order. 

import { ValidationPipeline } from './validationPipeline';
import { StatelessPipelineAdapter } from './validators/statelessPipelineAdapter';
import { SignatureValidator } from './validators/signatureValidator';
import { MalwareScanValidator } from './validators/malwareScanner';
import { MockScanner } from './scanners/mockScanner';

export function createDefaultPipeline(): ValidationPipeline {
  return new ValidationPipeline([
    // 1. Shared stateless validations (Filename, Whitelist, MIME, Size)
    new StatelessPipelineAdapter(),
    
    // 2. Client-only stateful validations
    new SignatureValidator(),
    new MalwareScanValidator(new MockScanner()),
  ]);
}

export { ValidationPipeline } from './validationPipeline';
export type { ValidationResult, Validator, MalwareScanner } from './types';
