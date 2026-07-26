import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignatureValidator } from './signatureValidator';

test('SignatureValidator passes for PNG with correct signature bytes', async () => {
    const validator = new SignatureValidator();
    const file = new File([new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])], 'image.png', { type: 'image/png' });
    const result = await validator.validate(file);
    assert.deepEqual(result, { passed: true });
});

test('SignatureValidator rejects PNG with wrong signature bytes', async () => {
    const validator = new SignatureValidator();
    const file = new File([new Uint8Array([0x00, 0x00, 0x00, 0x00])], 'image.png', { type: 'image/png' });
    const result = await validator.validate(file);
    assert.equal(result.passed, false);
    if (!result.passed) {
        assert.equal(result.code, 'SIGNATURE_MISMATCH');
        assert.match(result.message, /PNG/);
    }
});

test('SignatureValidator passes for JPG with correct signature bytes', async () => {
    const validator = new SignatureValidator();
    const file = new File([new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0])], 'image.jpg', { type: 'image/jpeg' });
    const result = await validator.validate(file);
    assert.deepEqual(result, { passed: true });
});

test('SignatureValidator passes for PDF with correct signature bytes', async () => {
    const validator = new SignatureValidator();
    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'document.pdf', { type: 'application/pdf' });
    const result = await validator.validate(file);
    assert.deepEqual(result, { passed: true });
});

test('SignatureValidator rejects PDF with wrong bytes', async () => {
    const validator = new SignatureValidator();
    const file = new File([new Uint8Array([0x00, 0x00, 0x00, 0x00])], 'document.pdf', { type: 'application/pdf' });
    const result = await validator.validate(file);
    assert.equal(result.passed, false);
    if (!result.passed) {
        assert.equal(result.code, 'SIGNATURE_MISMATCH');
    }
});

test('SignatureValidator passes for unknown extension .xyz unconditionally', async () => {
    const validator = new SignatureValidator();
    const file = new File([new Uint8Array([0x01, 0x02, 0x03, 0x04])], 'unknown.xyz', { type: 'application/octet-stream' });
    const result = await validator.validate(file);
    assert.deepEqual(result, { passed: true });
});

test('SignatureValidator rejects empty file with known extension .png', async () => {
    const validator = new SignatureValidator();
    const file = new File([], 'empty.png', { type: 'image/png' });
    const result = await validator.validate(file);
    assert.equal(result.passed, false);
    if (!result.passed) {
        assert.equal(result.code, 'SIGNATURE_EMPTY_FILE');
    }
});

test('SignatureValidator passes for file with no extension', async () => {
    const validator = new SignatureValidator();
    const file = new File([new Uint8Array([0x01, 0x02])], 'noextension', { type: 'application/octet-stream' });
    const result = await validator.validate(file);
    assert.deepEqual(result, { passed: true });
});
