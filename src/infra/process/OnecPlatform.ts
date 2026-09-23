import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { escape as escapeGlob, globSync } from 'glob';

const WINDOWS_EXECUTABLE = '1cv8.exe';
const UNIX_EXECUTABLES = ['1cv8', '1cv8c'] as const;
const UNIX_INSTALL_ROOTS: readonly string[] = ['/opt/1cv8', '/opt/1C/v8.3'];
// Единый установщик (setup-full-*.run, 8.3.20+) кладёт каталоги версий на уровень ниже —
// под каталог архитектуры: /opt/1cv8/x86_64/<версия>. Рядом лежат служебные common/ и conf/.
const UNIX_ARCH_DIRS = ['x86_64', 'i386'] as const;

export interface InstalledOnecPlatform {
  readonly executablePath: string;
  readonly version: string;
  readonly label: string;
}

/**
 * Находит исполняемый файл платформы 1С без привязки к Windows-каталогу.
 * Путь из настроек может быть файлом, каталогом bin, каталогом .app или именем из PATH.
 */
export function resolveV8ExecutablePath(v8Path: string, platform: NodeJS.Platform = process.platform): string {
  const explicitPath = trimOuterQuotes(v8Path).trim();
  if (explicitPath) {
    return resolveExplicitV8Path(explicitPath, platform);
  }

  const candidates = collectDefaultV8Candidates(platform);
  const found = pickLatestExistingPath(candidates, platform);
  if (found) {
    return found;
  }

  const hint = platform === 'win32'
    ? 'C:\\Program Files\\1cv8\\<версия>\\bin\\1cv8.exe'
    : '/Applications/1cv8.app или /opt/1cv8/.../1cv8';
  throw new Error(`Не найден исполняемый файл 1С. Укажите "--path" в env.json, например: ${hint}`);
}

/**
 * Нормализует путь файловой базы только по правилам текущей ОС.
 * На macOS/Linux абсолютные пути вида `/F/Users/...` должны остаться Unix-путями.
 * Для Unix-платформ при подстановке `~` используется posix-семантика
 * независимо от текущей ОС — иначе тесты под Windows получали бы Windows-путь.
 */
export function normalizeInfoBasePath(rawPath: string, platform: NodeJS.Platform = process.platform): string {
  let value = trimOuterQuotes(rawPath).trim();
  if (platform === 'win32') {
    value = value.replace(/\//g, '\\');
    value = value.replace(/^([A-Za-z]):\\+/, '$1:\\');
    if (!value.startsWith('\\\\')) {
      value = value.replace(/\\{2,}/g, '\\');
    }
    return value;
  }

  if (value === '~') {
    return resolveUnixHome(platform);
  }
  if (value.startsWith('~/')) {
    return path.posix.join(resolveUnixHome(platform), value.slice(2));
  }
  return value;
}

/**
 * Подбирает Unix-home для целевой платформы: на текущей ОС берём `os.homedir()`,
 * иначе используем устойчивые значения окружения (`HOME` или `/root`/`/home`),
 * чтобы результат не зависел от наличия буквы диска Windows-хоста.
 */
function resolveUnixHome(platform: NodeJS.Platform): string {
  if (platform === process.platform) {
    return os.homedir();
  }
  const envHome = process.env.HOME;
  if (envHome?.startsWith('/')) {
    return envHome;
  }
  const user = process.env.USER ?? process.env.USERNAME ?? 'user';
  return user === 'root' ? '/root' : `/home/${user}`;
}

/**
 * Строит подсказку пути к платформе по версии из env.json.
 * Нужна, чтобы `--v8version` продолжал работать без Windows-only автоопределения.
 * `unixInstallRoots` задаёт корни установки на macOS/Linux (для тестов на временной структуре).
 */
export function resolveV8PathHintFromVersion(
  version: string,
  platform: NodeJS.Platform = process.platform,
  unixInstallRoots: readonly string[] = UNIX_INSTALL_ROOTS
): string {
  const normalizedVersion = version.trim();
  if (!normalizedVersion) {
    return '';
  }

  const candidates = platform === 'win32'
    ? [
      `C:/Program Files/1cv8/${normalizedVersion}/bin`,
      `C:/Program Files (x86)/1cv8/${normalizedVersion}/bin`,
    ]
    : unixInstallRoots.flatMap((root) => [
      path.posix.join(root, normalizedVersion),
      ...UNIX_ARCH_DIRS.map((arch) => path.posix.join(root, arch, normalizedVersion)),
    ]);

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

/**
 * Возвращает все найденные установки платформы, чтобы пользователь мог явно выбрать версию для проекта.
 * `unixInstallRoots` задаёт корни установки на macOS/Linux (для тестов на временной структуре).
 */
export function scanInstalledOnecPlatforms(
  platform: NodeJS.Platform = process.platform,
  unixInstallRoots: readonly string[] = UNIX_INSTALL_ROOTS
): InstalledOnecPlatform[] {
  const candidates = collectDefaultV8Candidates(platform, unixInstallRoots);
  const existing = Array.from(new Set(candidates)).filter((candidate) =>
    isExistingFile(candidate) && isAllowedExecutable(candidate, platform)
  );

  const ordered = existing.sort((left, right) => compareCandidatePaths(right, left));

  return deduplicatePlatformCandidates(ordered)
    .map((executablePath) => {
      const version = extractVersion(executablePath).join('.');
      const name = path.basename(executablePath);
      return {
        executablePath,
        version,
        label: version ? `${version} (${name})` : executablePath,
      };
    });
}

function deduplicatePlatformCandidates(candidates: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const candidate of candidates) {
    const version = extractVersion(candidate).join('.');
    const key = version ? `version:${version}` : `path:${safeRealPath(candidate).toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(candidate);
  }

  return result;
}

function resolveExplicitV8Path(v8Path: string, platform: NodeJS.Platform): string {
  if (!hasPathSeparator(v8Path)) {
    const fromPath = findExecutableInPath(v8Path, platform);
    if (fromPath) {
      return fromPath;
    }
  }

  if (!fs.existsSync(v8Path)) {
    throw new Error(`Не найден исполняемый файл 1С: ${v8Path}`);
  }

  const stat = fs.statSync(v8Path);
  if (stat.isFile() && isAllowedExecutable(v8Path, platform)) {
    return v8Path;
  }
  if (stat.isDirectory()) {
    const found = pickLatestExistingPath(collectDirectoryCandidates(v8Path, platform), platform);
    if (found) {
      return found;
    }
  }

  throw new Error(`Не удалось определить исполняемый файл 1С по пути: ${v8Path}`);
}

function collectDefaultV8Candidates(
  platform: NodeJS.Platform,
  unixInstallRoots: readonly string[] = UNIX_INSTALL_ROOTS
): string[] {
  const candidates: string[] = [];

  if (platform === 'win32') {
    candidates.push(
      ...globSync('C:/Program Files/1cv8/*/bin/1cv8.exe', { windowsPathsNoEscape: true, nodir: true }),
      ...globSync('C:/Program Files (x86)/1cv8/*/bin/1cv8.exe', { windowsPathsNoEscape: true, nodir: true }),
      ...collectPathCandidates([WINDOWS_EXECUTABLE], platform)
    );
    return candidates;
  }

  if (platform === 'darwin') {
    candidates.push(
      ...collectMacAppCandidates('/Applications/**'),
      ...collectMacAppCandidates('/opt/1cv8/*'),
      ...unixInstallRoots.flatMap(collectUnixVersionCandidates)
    );
  } else {
    candidates.push(
      ...unixInstallRoots.flatMap(collectUnixVersionCandidates),
      '/usr/local/bin/1cv8',
      '/usr/bin/1cv8',
      '/usr/local/bin/1cv8c',
      '/usr/bin/1cv8c'
    );
  }

  candidates.push(...collectPathCandidates([...UNIX_EXECUTABLES], platform));
  return candidates;
}

function collectDirectoryCandidates(dirPath: string, platform: NodeJS.Platform): string[] {
  if (platform === 'win32') {
    return [
      path.join(dirPath, WINDOWS_EXECUTABLE),
      path.join(dirPath, 'bin', WINDOWS_EXECUTABLE),
    ];
  }

  const candidates = UNIX_EXECUTABLES.flatMap((name) => [
    path.join(dirPath, name),
    path.join(dirPath, 'bin', name),
    path.join(dirPath, 'Contents', 'MacOS', name),
  ]);
  // Пользователь может указать корень установки (/opt/1cv8) или каталог архитектуры, а не версии.
  candidates.push(...collectUnixVersionCandidates(dirPath));

  if (platform === 'darwin') {
    candidates.push(
      ...UNIX_EXECUTABLES.map((name) => path.join(dirPath, `${name}.app`, 'Contents', 'MacOS', name))
    );
  }

  return candidates;
}

function collectPathCandidates(names: string[], platform: NodeJS.Platform): string[] {
  return names
    .map((name) => findExecutableInPath(name, platform))
    .filter((candidate): candidate is string => Boolean(candidate));
}

/**
 * Ищет исполняемый файл по имени в каталогах PATH.
 * Единая реализация для платформы 1С и автономного сервера (ibsrv):
 * раньше дублировалась в StandaloneServerService.
 */
export function findExecutableInPath(commandName: string, platform: NodeJS.Platform = process.platform): string | null {
  const pathValue = process.env.PATH ?? '';
  const pathParts = pathValue.split(path.delimiter).filter(Boolean);
  const extensions = platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];
  const names = path.extname(commandName)
    ? [commandName]
    : extensions.map((ext) => `${commandName}${ext.toLowerCase()}`);

  for (const dir of pathParts) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isExistingFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function pickLatestExistingPath(candidates: string[], platform: NodeJS.Platform): string | null {
  const existing = Array.from(new Set(candidates)).filter((candidate) =>
    isExistingFile(candidate) && isAllowedExecutable(candidate, platform)
  );
  if (existing.length === 0) {
    return null;
  }
  return existing.sort(compareCandidatePaths).at(-1) ?? null;
}

function compareCandidatePaths(left: string, right: string): number {
  const leftVersion = extractVersion(left);
  const rightVersion = extractVersion(right);
  const length = Math.max(leftVersion.length, rightVersion.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (leftVersion[i] ?? 0) - (rightVersion[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  const executableDiff = executablePriority(left) - executablePriority(right);
  if (executableDiff !== 0) {
    return executableDiff;
  }
  const containerDiff = containerPriority(left) - containerPriority(right);
  if (containerDiff !== 0) {
    return containerDiff;
  }
  return left.localeCompare(right);
}

function extractVersion(filePath: string): number[] {
  const matches = filePath.match(/\d+(?:\.\d+)+/g);
  const version = matches?.at(-1) ?? '';
  return version.split('.').map((item) => Number.parseInt(item, 10)).filter(Number.isFinite);
}

function isExistingFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function safeRealPath(filePath: string): string {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return filePath;
  }
}

/**
 * Исполняемые файлы в каталогах версий под корнем установки: `<корень>/<версия>/` и
 * `<корень>/<архитектура>/<версия>/`. Старый deb-формат `/opt/1C/v8.3/x86_64/1cv8` без
 * каталога версии совпадает с первым шаблоном — архитектура стоит на месте версии.
 */
function collectUnixVersionCandidates(installRoot: string): string[] {
  // Корень экранируется: путь пользователя может содержать символы шаблона ([, *, ?).
  const escapedRoot = escapeGlob(installRoot);
  const versionGlobs = [
    path.posix.join(escapedRoot, '*'),
    ...UNIX_ARCH_DIRS.map((arch) => path.posix.join(escapedRoot, arch, '*')),
  ];
  return versionGlobs.flatMap((versionGlob) =>
    UNIX_EXECUTABLES.flatMap((name) => globSync(path.posix.join(versionGlob, name), { nodir: true }))
  );
}

function collectMacAppCandidates(rootGlob: string): string[] {
  return UNIX_EXECUTABLES.flatMap((name) =>
    globSync(path.join(rootGlob, `${name}.app`, 'Contents', 'MacOS', name), { nodir: true })
  );
}

function isAllowedExecutable(filePath: string, platform: NodeJS.Platform): boolean {
  const executableNames = platform === 'win32'
    ? [WINDOWS_EXECUTABLE]
    : [...UNIX_EXECUTABLES];
  return executableNames.includes(path.basename(filePath));
}

function executablePriority(filePath: string): number {
  switch (path.basename(filePath)) {
    case '1cv8':
    case WINDOWS_EXECUTABLE:
      return 2;
    case '1cv8c':
      return 1;
    default:
      return 0;
  }
}

function containerPriority(filePath: string): number {
  return filePath.includes('.app/Contents/MacOS') ? 0 : 1;
}

function hasPathSeparator(value: string): boolean {
  return value.includes('/') || value.includes('\\');
}

function trimOuterQuotes(value: string): string {
  return value.replace(/^"+|"+$/g, '');
}
