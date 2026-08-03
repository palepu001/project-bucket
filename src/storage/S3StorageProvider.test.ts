import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S3Client, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { contentDispositionFor, S3StorageProvider } from './S3StorageProvider';

const DUMMY_CREDS = {
  accessKeyId: 'AKIAFAKEFAKEFAKEFAKE',
  secretAccessKey: 'fakefakefakefakefakefakefakefakefakefake',
  region: 'us-east-1',
};

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

// Regression coverage for a real production bug: S3 rejected every presigned
// upload with "There were headers present in the request which were not
// signed. HeadersNotSigned: x-amz-checksum-sha256". getSignedUrl() hoists
// every x-amz-* header into the presigned URL's query string by default —
// including the checksum — so the client-sent header ended up outside
// SignedHeaders. Passing unhoistableHeaders keeps it a real signed header
// instead, which is also what makes S3 actually compute and store a
// server-side checksum for the object (a hoisted query param does not).
// getSignedUrl is a pure local SigV4 computation, so this runs with no
// network access and no real AWS account.
test('upload() signs the checksum as a real header instead of hoisting it into the query string', async () => {
  const provider = new S3StorageProvider(DUMMY_CREDS, 'test-bucket');
  const target = await provider.upload({
    ref: 'some/key.pdf',
    length: 123,
    checksum: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdead=',
    checksumType: 'SHA256',
    mimeType: 'application/pdf',
  });

  const url = new URL(target.url);
  const signedHeaders = url.searchParams.get('X-Amz-SignedHeaders') ?? '';
  assert.ok(
    signedHeaders.split(';').includes('x-amz-checksum-sha256'),
    `expected x-amz-checksum-sha256 in SignedHeaders, got: ${signedHeaders}`
  );
  assert.equal(
    url.searchParams.get('x-amz-checksum-sha256'),
    null,
    'checksum must not be hoisted into the query string once it is unhoistable'
  );
  assert.equal(target.headers?.['x-amz-checksum-sha256'], 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdead=');
  assert.equal(url.searchParams.get('X-Amz-Expires'), '300');
});

test('download() URLs expire after five minutes', async (t) => {
  t.mock.method(S3Client.prototype, 'send', async (command: unknown) => {
    assert.ok(command instanceof HeadObjectCommand);
    return {};
  });

  const provider = new S3StorageProvider(DUMMY_CREDS, 'test-bucket');
  const target = await provider.download('some/key.pdf');
  const url = new URL(target.url);
  assert.equal(url.searchParams.get('X-Amz-Expires'), '300');
});

// Regression coverage: HeadObject silently omits ChecksumSHA256 from its
// response unless the request sets ChecksumMode: 'ENABLED' — even when the
// object genuinely has a stored checksum. Without this, the storage audit's
// checksum comparison always reports "Does not match" regardless of whether
// the upload was actually fine.
test('exists() requests ChecksumMode ENABLED so HeadObject returns the stored checksum', async (t) => {
  const provider = new S3StorageProvider(DUMMY_CREDS, 'test-bucket');
  const send = t.mock.method(S3Client.prototype, 'send', async (command: unknown) => {
    assert.ok(command instanceof HeadObjectCommand);
    assert.equal(command.input.ChecksumMode, 'ENABLED');
    return { ContentLength: 42, ChecksumSHA256: 'abc=', LastModified: new Date() };
  });

  const [result] = await provider.exists(['some/key.pdf']);
  assert.equal(send.mock.callCount(), 1);
  assert.equal(result.status, 'found');
  assert.equal(result.summary?.checksum, 'abc=');
});

test('readHeaderBytes() performs a bounded range read', async (t) => {
  const provider = new S3StorageProvider(DUMMY_CREDS, 'test-bucket');
  const send = t.mock.method(S3Client.prototype, 'send', async (command: unknown) => {
    assert.ok(command instanceof GetObjectCommand);
    assert.equal(command.input.Range, 'bytes=0-7');
    return { Body: { transformToByteArray: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]) } };
  });

  const bytes = await provider.readHeaderBytes('some/key.pdf', 8);
  assert.equal(send.mock.callCount(), 1);
  assert.deepEqual(Array.from(bytes ?? []), [0x25, 0x50, 0x44, 0x46]);
});
