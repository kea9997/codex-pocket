import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { sampleImage } from '../tools/sample-image.mjs';

export function imageFixture(t) {
  // OS temp/AppData is intentionally blocked. Use a NEW generated-only directory outside the checkout.
  const dir = mkdtempSync(join(homedir(), 'codex-pocket-raster-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'sample with spaces.png'); writeFileSync(file, sampleImage());
  return { dir, file };
}
