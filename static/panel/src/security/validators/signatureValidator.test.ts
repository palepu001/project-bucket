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
    // Not MZ or any other dangerous magic — just wrong for PNG.
    const file = new File([new Uint8Array([0x52, 0x49, 0x46, 0x46])], 'image.png', { type: 'image/png' });
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
    // Not dangerous magic, just wrong for PDF.
    const file = new File([new Uint8Array([0x52, 0x49, 0x46, 0x46])], 'document.pdf', { type: 'application/pdf' });
    const result = await validator.validate(file);
    assert.equal(result.passed, false);
    if (!result.passed) {
        assert.equal(result.code, 'SIGNATURE_MISMATCH');
    }
});

test('SignatureValidator passes for unknown extension .xyz with non-dangerous bytes', async () => {
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

test('SignatureValidator passes plain text for .txt (no fixed magic bytes)', async () => {
    const validator = new SignatureValidator();
    const file = new File(['hello, world'], 'notes.txt', { type: 'text/plain' });
    const result = await validator.validate(file);
    assert.deepEqual(result, { passed: true });
});

test('SignatureValidator rejects binary content masquerading as .txt', async () => {
    const validator = new SignatureValidator();
    const file = new File([new Uint8Array([0x68, 0x69, 0x00, 0x68, 0x69])], 'notes.txt', { type: 'text/plain' });
    const result = await validator.validate(file);
    assert.equal(result.passed, false);
    if (!result.passed) {
        assert.equal(result.code, 'BINARY_CONTENT_MISMATCH');
    }
});

test('SignatureValidator matches an offset signature (mp4 ftyp box)', async () => {
    const validator = new SignatureValidator();
    const bytes = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    const file = new File([bytes], 'clip.mp4', { type: 'video/mp4' });
    const result = await validator.validate(file);
    assert.deepEqual(result, { passed: true });
});

test('SignatureValidator rejects mp4 content missing the ftyp box', async () => {
    const validator = new SignatureValidator();
    const bytes = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x41, 0x41, 0x41, 0x41]);
    const file = new File([bytes], 'clip.mp4', { type: 'video/mp4' });
    const result = await validator.validate(file);
    assert.equal(result.passed, false);
    if (!result.passed) {
        assert.equal(result.code, 'SIGNATURE_MISMATCH');
    }
});

test('SignatureValidator rejects an SVG containing an inline script', async () => {
    const validator = new SignatureValidator();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const file = new File([svg], 'icon.svg', { type: 'image/svg+xml' });
    const result = await validator.validate(file);
    assert.equal(result.passed, false);
    if (!result.passed) {
        assert.equal(result.code, 'SVG_UNSAFE_MARKUP');
    }
});

test('SignatureValidator accepts a plain SVG with no script content', async () => {
    const validator = new SignatureValidator();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>';
    const file = new File([svg], 'icon.svg', { type: 'image/svg+xml' });
    const result = await validator.validate(file);
    assert.deepEqual(result, { passed: true });
});

// --- Dangerous magic detection tests ---

test('SignatureValidator blocks a file with MZ (PE/DOS) header regardless of extension', async () => {
    const validator = new SignatureValidator();
    // MZ header bytes — this is a Windows executable regardless of what the extension says.
    const file = new File([new Uint8Array([0x4D, 0x5A, 0x90, 0x00, 0x03, 0x00])], 'project.exr', { type: 'application/octet-stream' });
    const result = await validator.validate(file);
    assert.equal(result.passed, false);
    if (!result.passed) {
        assert.equal(result.code, 'DANGEROUS_CONTENT');
        assert.match(result.message, /PE\/DOS/);
    }
});

test('SignatureValidator blocks a file with ELF header regardless of extension', async () => {
    const validator = new SignatureValidator();
    // ELF header bytes — this is a Linux executable.
    const file = new File([new Uint8Array([0x7F, 0x45, 0x4C, 0x46, 0x02, 0x01])], 'render.blend', { type: 'application/octet-stream' });
    const result = await validator.validate(file);
    assert.equal(result.passed, false);
    if (!result.passed) {
        assert.equal(result.code, 'DANGEROUS_CONTENT');
        assert.match(result.message, /ELF/);
    }
});

test('SignatureValidator blocks a file with shebang header regardless of extension', async () => {
    const validator = new SignatureValidator();
    // #!/bin/bash — this is a shell script.
    const file = new File([new Uint8Array([0x23, 0x21, 0x2F, 0x62, 0x69, 0x6E])], 'data.csv', { type: 'text/csv' });
    const result = await validator.validate(file);
    assert.equal(result.passed, false);
    if (!result.passed) {
        assert.equal(result.code, 'DANGEROUS_CONTENT');
        assert.match(result.message, /shebang/);
    }
});

test('SignatureValidator blocks a file with Mach-O header regardless of extension', async () => {
    const validator = new SignatureValidator();
    // Mach-O 64-bit little-endian header.
    const file = new File([new Uint8Array([0xCF, 0xFA, 0xED, 0xFE, 0x07, 0x00])], 'scene.usd', { type: 'application/octet-stream' });
    const result = await validator.validate(file);
    assert.equal(result.passed, false);
    if (!result.passed) {
        assert.equal(result.code, 'DANGEROUS_CONTENT');
        assert.match(result.message, /Mach-O/);
    }
});

test('SignatureValidator allows an unknown extension with harmless bytes', async () => {
    const validator = new SignatureValidator();
    // Random bytes that do not match any dangerous signature.
    const file = new File([new Uint8Array([0x76, 0x2F, 0x31, 0x20, 0x00, 0x00, 0x00, 0x01])], 'plate.dpx', { type: 'application/octet-stream' });
    const result = await validator.validate(file);
    assert.deepEqual(result, { passed: true });
});
