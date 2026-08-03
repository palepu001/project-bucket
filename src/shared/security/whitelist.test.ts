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
    assert.strictEqual(validate('scene.exr').passed, true);
    assert.strictEqual(validate('model.blend').passed, true);
    assert.strictEqual(validate('script.nk').passed, true);
  });

  await t.test('blocks unlisted/unknown extensions', () => {
    assert.strictEqual(validate('data.custom').passed, false);
    assert.strictEqual(validate('file.xyz').passed, false);
    assert.strictEqual(validate('document.docm').passed, false); // specific test case mentioned by user
  });

  await t.test('blocks files without an extension', () => {
    assert.strictEqual(validate('Makefile').passed, false);
    assert.strictEqual(validate('README').passed, false);
  });

  await t.test('blocks dangerous extensions', () => {
    const res = validate('script.bat');
    assert.strictEqual(res.passed, false);
    if (!res.passed) {
      assert.strictEqual(res.code, 'FORBIDDEN_EXTENSION');
    }
  });

  await t.test('blocks executables', () => {
    assert.strictEqual(validate('installer.exe').passed, false);
    assert.strictEqual(validate('tool.msi').passed, false);
    assert.strictEqual(validate('helper.scr').passed, false);
    assert.strictEqual(validate('library.dll').passed, false);
  });

  await t.test('blocks script files', () => {
    assert.strictEqual(validate('setup.sh').passed, false);
    assert.strictEqual(validate('deploy.ps1').passed, false);
    assert.strictEqual(validate('macro.vbs').passed, false);
    assert.strictEqual(validate('code.jar').passed, false);
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
