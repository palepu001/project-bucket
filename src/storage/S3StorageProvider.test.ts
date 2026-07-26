import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentDispositionFor } from './S3StorageProvider';

// Coverage for the Content-Disposition the storage location sets on a download
// URL. This is the whole mechanism behind "Download saves the file under its
// real name": an `<a download>` hint is ignored for cross-origin URLs, so if
// this header is wrong the browser either renders the file inline or saves it
// under the opaque object key (a UUID with no extension).
// Run with: npm test

test('disposition marks the response as an attachment, not inline', () => {
  const value = contentDispositionFor('report.pdf');
  assert.ok(value.startsWith('attachment;'), value);
});

test('a plain ASCII name round-trips in both the fallback and the UTF-8 form', () => {
  const value = contentDispositionFor('quarterly report.pdf');
  assert.ok(value.includes('filename="quarterly report.pdf"'), value);
  assert.ok(value.includes("filename*=UTF-8''quarterly%20report.pdf"), value);
});

test('non-ASCII names survive via filename* and degrade safely in the fallback', () => {
  const value = contentDispositionFor('отчёт.pdf');
  // The RFC 5987 form carries the real name...
  assert.ok(value.includes("filename*=UTF-8''"), value);
  assert.equal(
    value.includes(encodeURIComponent('отчёт.pdf')),
    true,
    'percent-encoded UTF-8 name must be present'
  );
  // ...while the ASCII fallback must contain no raw non-ASCII bytes, which
  // would make the header unparseable for clients that only read `filename`.
  const fallback = /filename="([^"]*)"/.exec(value)?.[1] ?? '';
  assert.match(fallback, /^[\x20-\x7e]*$/, `fallback not ASCII-safe: ${fallback}`);
});

test('a quote in the filename cannot terminate the quoted-string early', () => {
  // Without escaping, this would close `filename="` and let the rest of the
  // name be read as additional header parameters.
  const value = contentDispositionFor('evil".pdf');
  const fallback = /filename="([^"]*)"/.exec(value)?.[1] ?? '';
  assert.ok(!fallback.includes('"'), `unescaped quote leaked into fallback: ${fallback}`);
  assert.equal(value.split('"').length - 1, 2, `expected exactly one quoted pair: ${value}`);
});

test('a backslash cannot escape out of the quoted-string either', () => {
  const value = contentDispositionFor('back\\slash.pdf');
  const fallback = /filename="([^"]*)"/.exec(value)?.[1] ?? '';
  assert.ok(!fallback.includes('\\'), `unescaped backslash leaked into fallback: ${fallback}`);
});

test('a newline in the filename cannot inject a second header', () => {
  const value = contentDispositionFor('a\r\nX-Injected: 1.pdf');
  assert.ok(!value.includes('\r'), value);
  assert.ok(!value.includes('\n'), value);
});
