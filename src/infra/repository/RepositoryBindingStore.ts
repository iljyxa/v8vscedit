import * as fs from 'fs';
import * as path from 'path';
import type { ProjectSecretStorage } from '../environment/ProjectSecretStorage';
import { buildRepositoryScopeKey } from './RepositoryLockState';
import type { RepositoryBinding, RepositoryTarget, StoredRepositoryBinding } from './RepositoryService';

interface CachedEnv {
  mtimeMs: number;
  value: Record<string, unknown>;
}

/**
 * Привязка цели к хранилищу в `env.json` (путь и пользователь) и пароль в
 * `ProjectSecretStorage`. Пароль в `env.json` не пишется; оставшийся от прежних
 * версий legacy-пароль мигрируется в SecretStorage при первом чтении.
 */
export class RepositoryBindingStore {
  private envCache: CachedEnv | undefined;

  constructor(
    private readonly workspaceRoot: string,
    private readonly secrets: ProjectSecretStorage
  ) {}

  getEnvJsonPath(): string {
    return path.join(this.workspaceRoot, 'env.json');
  }

  async loadBinding(target: RepositoryTarget): Promise<StoredRepositoryBinding | null> {
    const raw = this.readBindingRaw(target);
    if (!raw) {
      return null;
    }
    if (raw.legacyPassword.trim()) {
      await this.secrets.setRepoPassword(buildRepositoryScopeKey(target), raw.legacyPassword);
      this.eraseLegacyRepoPassword(target);
    }
    return { repoPath: raw.repoPath, repoUser: raw.repoUser };
  }

  async saveBinding(target: RepositoryTarget, binding: RepositoryBinding): Promise<void> {
    const env = this.readEnvFile();
    const defaults = getDefaultSection(env);
    if (target.configKind === 'cfe') {
      const extensionSection = getExtensionSection(defaults);
      extensionSection[target.extensionName ?? ''] = {
        'repo-path': binding.repoPath,
        'repo-user': binding.repoUser,
      };
      defaults.extension = extensionSection;
    } else {
      defaults['--repo-path'] = binding.repoPath;
      defaults['--repo-user'] = binding.repoUser;
      delete defaults['--repo-pwd'];
    }
    env.default = defaults;
    this.writeEnvFile(env);
    // Непустой ввод обновляет секрет; пустой пароль означает «оставить сохранённый».
    if (binding.repoPassword.trim()) {
      await this.secrets.setRepoPassword(buildRepositoryScopeKey(target), binding.repoPassword);
    }
  }

  async clearBinding(target: RepositoryTarget): Promise<void> {
    const env = this.readEnvFile();
    const defaults = getDefaultSection(env);
    if (target.configKind === 'cfe') {
      const extensionName = target.extensionName ?? '';
      defaults.extension = Object.fromEntries(
        Object.entries(getExtensionSection(defaults)).filter(([name]) => name !== extensionName)
      );
    } else {
      delete defaults['--repo-path'];
      delete defaults['--repo-user'];
      delete defaults['--repo-pwd'];
    }
    env.default = defaults;
    this.writeEnvFile(env);
    await this.secrets.setRepoPassword(buildRepositoryScopeKey(target), '');
  }

  async hasStoredRepoPassword(target: RepositoryTarget): Promise<boolean> {
    return this.secrets.hasRepoPassword(buildRepositoryScopeKey(target));
  }

  /** Полная привязка с паролем из SecretStorage — только в памяти для запуска команды 1С. */
  async resolveBindingForCommand(target: RepositoryTarget): Promise<RepositoryBinding | null> {
    const stored = await this.loadBinding(target);
    if (!stored) {
      return null;
    }
    const repoPassword = await this.secrets.getRepoPassword(buildRepositoryScopeKey(target));
    return { repoPath: stored.repoPath, repoUser: stored.repoUser, repoPassword: repoPassword ?? '' };
  }

  hasBinding(target: RepositoryTarget): boolean {
    return this.readBindingRaw(target) !== null;
  }

  /**
   * Синхронное чтение привязки без SecretStorage — для проверок на hot path и
   * последующей асинхронной миграции legacy-пароля.
   */
  private readBindingRaw(
    target: RepositoryTarget
  ): { repoPath: string; repoUser: string; legacyPassword: string } | null {
    const defaults = getDefaultSection(this.readEnvFile());
    if (target.configKind === 'cfe') {
      const item = getRawExtensionSection(defaults)[target.extensionName ?? ''] as Record<string, unknown> | undefined;
      const repoPath = readString(item?.['repo-path']);
      if (!repoPath) {
        return null;
      }
      return {
        repoPath,
        repoUser: readString(item?.['repo-user']) ?? '',
        legacyPassword: readString(item?.['repo-pwd']) ?? '',
      };
    }
    const repoPath = readString(defaults['--repo-path']);
    if (!repoPath) {
      return null;
    }
    return {
      repoPath,
      repoUser: readString(defaults['--repo-user']) ?? '',
      legacyPassword: readString(defaults['--repo-pwd']) ?? '',
    };
  }

  private eraseLegacyRepoPassword(target: RepositoryTarget): void {
    const env = this.readEnvFile();
    const defaults = getDefaultSection(env);
    if (target.configKind === 'cfe') {
      const item = getRawExtensionSection(defaults)[target.extensionName ?? ''] as Record<string, unknown> | undefined;
      if (item) {
        delete item['repo-pwd'];
      }
    } else {
      delete defaults['--repo-pwd'];
    }
    env.default = defaults;
    this.writeEnvFile(env);
  }

  private readEnvFile(): Record<string, unknown> {
    const envPath = this.getEnvJsonPath();
    const mtimeMs = getFileMtimeMs(envPath) ?? -1;
    if (this.envCache?.mtimeMs === mtimeMs) {
      return this.envCache.value;
    }
    const raw = mtimeMs < 0 ? '' : fs.readFileSync(envPath, 'utf-8');
    // Пустой env.json — легитимное состояние (создан инициализацией, но не заполнен).
    if (raw.trim().length === 0) {
      const empty = { default: {} };
      this.envCache = { mtimeMs, value: empty };
      return empty;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`env.json повреждён (${envPath}): ${reason}`, { cause: error });
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`env.json повреждён (${envPath}): ожидался объект`);
    }
    const value = parsed as Record<string, unknown>;
    this.envCache = { mtimeMs, value };
    return value;
  }

  private writeEnvFile(env: Record<string, unknown>): void {
    const envPath = this.getEnvJsonPath();
    fs.mkdirSync(path.dirname(envPath), { recursive: true });
    fs.writeFileSync(envPath, `${JSON.stringify(env, null, 2)}\n`, 'utf-8');
    this.envCache = { mtimeMs: getFileMtimeMs(envPath) ?? Date.now(), value: env };
  }
}

function getDefaultSection(env: Record<string, unknown>): Record<string, unknown> {
  const defaults = env.default;
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) {
    return {};
  }
  return { ...(defaults as Record<string, unknown>) };
}

function getExtensionSection(defaults: Record<string, unknown>): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  for (const [key, item] of Object.entries(getRawExtensionSection(defaults))) {
    result[key] = {
      'repo-path': readString(item['repo-path']) ?? '',
      'repo-user': readString(item['repo-user']) ?? '',
    };
  }
  return result;
}

/** Секция расширений с сохранением `repo-pwd` — нужна для миграции legacy-пароля. */
function getRawExtensionSection(defaults: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const raw = defaults.extension;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const result: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = value as Record<string, unknown>;
    }
  }
  return result;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function getFileMtimeMs(filePath: string): number | undefined {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return undefined;
  }
}
