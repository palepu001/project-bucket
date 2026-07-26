import test from 'node:test';
import assert from 'node:assert';
import { WhitelistValidator } from './validators/statelessPipeline';


test('WhitelistValidator', async (t) => {
  const validator = new WhitelistValidator();

  const validate = (filename: string): ReturnType<typeof validator.validate> => {
    return validator.validate({ filename, size: 100, mimeType: 'text/plain' });
  };

  await t.test('passes allowed extensions', () => {
    assert.strictEqual(validate('document.pdf').passed, true);
    assert.strictEqual(validate('image.png').passed, true);
  });

  await t.test('blocks forbidden extensions', () => {
    const res = validate('script.bat');
    assert.strictEqual(res.passed, false);
    if (!res.passed) {
      assert.strictEqual(res.code, 'FORBIDDEN_EXTENSION');
    }
  });

  await t.test('blocks double-extension padding disguising executables', () => {
    const res = validate('report.exe.pdf');
    assert.strictEqual(res.passed, false);
    if (!res.passed) {
      assert.strictEqual(res.code, 'FORBIDDEN_EXTENSION');
      assert.strictEqual(res.message, 'The file appears to disguise a blocked extension.');
    }
  });

  await t.test('allows safe double-extensions', () => {
    assert.strictEqual(validate('app.v1.pdf').passed, true);
    assert.strictEqual(validate('archive.tar.gz').passed, true);
  });
});
