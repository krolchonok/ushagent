import fs from 'node:fs';
import path from 'node:path';

export function getPackedTarballPath(rootDir = process.cwd()) {
  const entries = fs
    .readdirSync(rootDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^ushagent-.*\.tgz$/i.test(entry.name))
    .map(entry => {
      const filePath = path.join(rootDir, entry.name);
      return {
        filePath,
        mtimeMs: fs.statSync(filePath).mtimeMs,
      };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  if (entries.length === 0) {
    throw new Error('Packed tarball not found. Run `npm pack` first.');
  }

  return entries[0].filePath;
}
