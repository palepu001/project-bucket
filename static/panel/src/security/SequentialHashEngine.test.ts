import test from 'node:test';
import assert from 'node:assert';
import { SequentialHashEngine } from './SequentialHashEngine';

test('SequentialHashEngine', async (t) => {
  await t.test('computes hashes sequentially without failing', async () => {
    // We can simulate Files with Blob in modern Node
    const files = [
      new Blob(['file1'], { type: 'text/plain' }) as any as File,
      new Blob(['file2'], { type: 'text/plain' }) as any as File,
      new Blob(['file3'], { type: 'text/plain' }) as any as File,
    ];

    const hashes = await SequentialHashEngine.computeHashes(files);
    
    assert.strictEqual(hashes.length, 3);
    assert.strictEqual(typeof hashes[0], 'string');
    // Ensure they are distinct
    assert.notStrictEqual(hashes[0], hashes[1]);
  });
});
