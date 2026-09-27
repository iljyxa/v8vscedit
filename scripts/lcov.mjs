import * as path from 'node:path';

// Разбор lcov в карту: absPath → { da: Map<line,hits>, brda: Map<line,taken[]> }.
export function parseLcov(text, root) {
  const files = new Map();
  let cur = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      const p = line.slice(3);
      cur = { da: new Map(), brda: new Map() };
      files.set(path.resolve(root, p), cur);
    } else if (cur && line.startsWith('DA:')) {
      const [ln, hits] = line.slice(3).split(',');
      cur.da.set(Number(ln), Number(hits));
    } else if (cur && line.startsWith('BRDA:')) {
      const [ln, , , taken] = line.slice(5).split(',');
      const arr = cur.brda.get(Number(ln)) ?? [];
      arr.push(taken);
      cur.brda.set(Number(ln), arr);
    } else if (line === 'end_of_record') {
      cur = null;
    }
  }
  return files;
}
