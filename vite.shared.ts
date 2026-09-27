import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const rootDir = path.dirname(fileURLToPath(import.meta.url));

export const aliases = {
  '@ui': path.resolve(rootDir, 'src-ui'),
  '@ui-shared': path.resolve(rootDir, 'src-ui/shared'),
};

/*
 * Внешними остаются только модули, которые даёт среда выполнения. Всё остальное вшивается в
 * бандл: VSIX не должен зависеть от node_modules, иначе `vsce package --no-dependencies`
 * выпускает пакет без них, и активация падает на первом require. ssh2 вшивается
 * целиком; cpu-features — его опциональный нативный аддон, ssh2 загружает его в try/catch
 * и без аддона работает на чистом JS.
 */
export const nodeExternal = [
  'vscode',
  '@vscode/test-electron',
  'cpu-features',
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
];

export interface WebviewManifestEntry {
  readonly script: string;
  readonly styles: readonly string[];
}

export type WebviewManifest = Record<string, WebviewManifestEntry>;
