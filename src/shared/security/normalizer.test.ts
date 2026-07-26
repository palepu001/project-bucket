import test from 'node:test';
import assert from 'node:assert';
import { FileNormalizer } from './normalizer';

test('FileNormalizer', async (t) => {
  await t.test('normalizeFilename - trims trailing spaces', () => {
    assert.strictEqual(FileNormalizer.normalizeFilename('virus.exe '), 'virus.exe');
    assert.strictEqual(FileNormalizer.normalizeFilename('virus.exe   '), 'virus.exe');
  });

  await t.test('normalizeFilename - trims trailing dots', () => {
    assert.strictEqual(FileNormalizer.normalizeFilename('virus.exe.'), 'virus.exe');
    assert.strictEqual(FileNormalizer.normalizeFilename('virus.exe...'), 'virus.exe');
  });

  await t.test('normalizeFilename - strips RTL overrides and unicode controls', () => {
    assert.strictEqual(FileNormalizer.normalizeFilename('invoice\u202Etxt.exe'), 'invoicetxt.exe');
    assert.strictEqual(FileNormalizer.normalizeFilename('file\u200E.txt'), 'file.txt');
  });

  await t.test('normalizeFilename - replaces colons', () => {
    assert.strictEqual(FileNormalizer.normalizeFilename('mac:file.txt'), 'mac-file.txt');
  });

  await t.test('extractExtension - extracts correct extension', () => {
    assert.strictEqual(FileNormalizer.extractExtension('file.pdf'), 'pdf');
    assert.strictEqual(FileNormalizer.extractExtension('file.PDF'), 'pdf');
    assert.strictEqual(FileNormalizer.extractExtension('noextension'), '');
    assert.strictEqual(FileNormalizer.extractExtension('.hidden'), 'hidden');
  });
});
