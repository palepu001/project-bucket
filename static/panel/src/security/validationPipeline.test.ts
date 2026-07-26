import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ValidationPipeline } from './validationPipeline';
import { createDefaultPipeline } from './index';
import { Validator } from './types';

// ---------------------------------------------------------------------------
// Integration tests for the validation pipeline. These verify the pipeline's
// orchestration logic (ordering, short-circuit, error handling) and the
// default pipeline factory, not individual validator logic.
// ---------------------------------------------------------------------------

test('Full pipeline passes for a valid PNG file', async () => {
  const pipeline = createDefaultPipeline();
  // Valid PNG magic bytes, reasonable name and MIME, tiny size.
  const file = new File(
    [new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])],
    'photo.png',
    { type: 'image/png' }
  );
  const result = await pipeline.run(file);
  assert.deepEqual(result, { passed: true });
});

test('Pipeline stops on first failure — subsequent validators are not called', async () => {
  let thirdValidatorCalled = false;
  const validator1: Validator = {
    name: 'Pass1',
    validate: async () => ({ passed: true }),
  };
  const validator2: Validator = {
    name: 'Fail2',
    validate: async () => ({
      passed: false,
      code: 'FAIL_2',
      message: 'failed on 2',
      validator: 'Fail2',
    }),
  };
  const validator3: Validator = {
    name: 'Pass3',
    validate: async () => {
      thirdValidatorCalled = true;
      return { passed: true };
    },
  };

  const pipeline = new ValidationPipeline([validator1, validator2, validator3]);
  const file = new File(['content'], 'test.txt', { type: 'text/plain' });
  const result = await pipeline.run(file);

  assert.equal(result.passed, false);
  if (!result.passed) {
    assert.equal(result.code, 'FAIL_2');
    assert.equal(result.message, 'failed on 2');
    assert.equal(result.validator, 'Fail2');
  }
  assert.equal(thirdValidatorCalled, false, 'Third validator should not have been called');
});

test('Pipeline returns failure with correct code, message, and validator name', async () => {
  const failValidator: Validator = {
    name: 'FailValidator',
    validate: async () => ({
      passed: false,
      code: 'TEST_FAIL',
      message: 'Test failure message',
      validator: 'FailValidator',
    }),
  };
  const pipeline = new ValidationPipeline([failValidator]);
  const file = new File(['content'], 'test.txt', { type: 'text/plain' });
  const result = await pipeline.run(file);

  assert.equal(result.passed, false);
  if (!result.passed) {
    assert.equal(result.code, 'TEST_FAIL');
    assert.equal(result.message, 'Test failure message');
    assert.equal(result.validator, 'FailValidator');
  }
});

test('Pipeline handles a throwing validator gracefully', async () => {
  const throwingValidator: Validator = {
    name: 'ThrowingValidator',
    validate: async () => {
      throw new Error('Unexpected crash');
    },
  };
  const pipeline = new ValidationPipeline([throwingValidator]);
  const file = new File(['content'], 'test.txt', { type: 'text/plain' });
  const result = await pipeline.run(file);

  assert.equal(result.passed, false);
  if (!result.passed) {
    assert.equal(result.code, 'VALIDATOR_ERROR');
    assert.equal(result.validator, 'ThrowingValidator');
  }
});

test('Default pipeline has 3 validators', () => {
  const pipeline = createDefaultPipeline();
  assert.equal(pipeline.length, 3);
});

test('Pipeline rejects .exe file via the default pipeline', async () => {
  const pipeline = createDefaultPipeline();
  const file = new File(['MZ executable content...'], 'virus.exe', {
    type: 'application/x-msdownload',
  });
  const result = await pipeline.run(file);
  assert.equal(result.passed, false);
});
