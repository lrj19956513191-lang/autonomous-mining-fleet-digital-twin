// Test-only input from the sole spatial source. This does not reproduce backend densification.
import { readFileSync } from 'node:fs';

export function makeSceneInput(): unknown {
  return structuredClone(JSON.parse(readFileSync(
    new URL('../../../backend/data/demo_mine.json', import.meta.url), 'utf8',
  )) as unknown);
}
