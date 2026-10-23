import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('dsh-session-rewind', () => {
  it('should export plugin name and version', async () => {
    const mod = await import('./index.js');
    assert.strictEqual(mod.name, 'dsh-session-rewind');
    assert.strictEqual(mod.version, '0.1.0');
  });

  it('should export apply function', async () => {
    const mod = await import('./index.js');
    assert.strictEqual(typeof mod.apply, 'function');
  });
});
