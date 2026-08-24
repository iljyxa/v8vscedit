import * as fs from 'fs';
import * as path from 'path';
import type { AgentConfigurationTarget } from '../../domain/agent';

export interface AgentWorkspacePaths {
  readonly projectRoot: string;
  readonly agentRoot: string;
  readonly sessionsRoot: string;
  readonly workspaceRoot: string;
  readonly listsRoot: string;
  readonly exchangeRoot: string;
  readonly targetDir: string;
  readonly targetAgentDir: string;
}

export class AgentWorkspaceService {
  constructor(private readonly projectRoot: string) {}

  resolveWorkspace(sessionId: string, target: AgentConfigurationTarget): AgentWorkspacePaths {
    const safeSessionId = sanitizePathPart(sessionId);
    const agentRoot = path.join(this.projectRoot, '.v8vscedit', 'agent');
    const agentFileRoot = path.join(agentRoot, '0');
    const workspaceRoot = path.join(agentFileRoot, 'workspace', safeSessionId);
    const agentWorkspaceRoot = path.posix.join('workspace', safeSessionId);
    const targetDir = target.kind === 'cf'
      ? path.join(workspaceRoot, 'cf')
      : path.join(workspaceRoot, 'cfe', sanitizePathPart(requireExtensionName(target)));
    const targetAgentDir = target.kind === 'cf'
      ? path.posix.join(agentWorkspaceRoot, 'cf')
      : path.posix.join(agentWorkspaceRoot, 'cfe', sanitizePathPart(requireExtensionName(target)));

    return {
      projectRoot: this.projectRoot,
      agentRoot,
      sessionsRoot: path.join(agentRoot, 'sessions'),
      workspaceRoot,
      listsRoot: path.join(agentFileRoot, 'lists'),
      exchangeRoot: path.join(agentFileRoot, 'exchange'),
      targetDir,
      targetAgentDir,
    };
  }

  ensureWorkspace(sessionId: string, target: AgentConfigurationTarget): AgentWorkspacePaths {
    const workspace = this.resolveWorkspace(sessionId, target);
    fs.mkdirSync(workspace.sessionsRoot, { recursive: true });
    fs.mkdirSync(workspace.workspaceRoot, { recursive: true });
    fs.mkdirSync(workspace.listsRoot, { recursive: true });
    fs.mkdirSync(workspace.exchangeRoot, { recursive: true });
    fs.mkdirSync(workspace.targetDir, { recursive: true });
    return workspace;
  }

  writeListFile(operationId: string, relativeFiles: readonly string[]): string {
    const listPath = path.join(this.getAgentFileRoot(), 'lists', `${sanitizePathPart(operationId)}.txt`);
    fs.mkdirSync(path.dirname(listPath), { recursive: true });
    const normalized = relativeFiles.map(normalizeRelativeFilePath);
    fs.writeFileSync(listPath, `\uFEFF${normalized.join('\n')}`, 'utf-8');
    return listPath;
  }

  /**
   * \u041F\u0438\u0448\u0435\u0442 list-\u0444\u0430\u0439\u043B \u0434\u043B\u044F \u0447\u0430\u0441\u0442\u0438\u0447\u043D\u043E\u0433\u043E `dump-config-to-files --list-file` \u2014 \u0432 \u043E\u0442\u043B\u0438\u0447\u0438\u0435
   * \u043E\u0442 {@link writeListFile}, \u0441\u043E\u0434\u0435\u0440\u0436\u0438\u043C\u043E\u0435 \u0437\u0434\u0435\u0441\u044C \u043D\u0435 \u043E\u0442\u043D\u043E\u0441\u0438\u0442\u0435\u043B\u044C\u043D\u044B\u0435 \u043F\u0443\u0442\u0438 \u0444\u0430\u0439\u043B\u043E\u0432, \u0430
   * fullName \u043E\u0431\u044A\u0435\u043A\u0442\u043E\u0432 \u0445\u0440\u0430\u043D\u0438\u043B\u0438\u0449\u0430 (\u043D\u0430\u043F\u0440\u0438\u043C\u0435\u0440, `\u0421\u043F\u0440\u0430\u0432\u043E\u0447\u043D\u0438\u043A.\u041D\u043E\u043C\u0435\u043D\u043A\u043B\u0430\u0442\u0443\u0440\u0430`). \u0424\u043E\u0440\u043C\u0430\u0442
   * \u0442\u043E\u0442 \u0436\u0435 (BOM + \u043F\u0435\u0440\u0435\u0432\u043E\u0434 \u0441\u0442\u0440\u043E\u043A\u0438), \u043D\u043E \u0432\u0430\u043B\u0438\u0434\u0430\u0446\u0438\u044F \u043F\u0443\u0442\u0435\u0439 \u043D\u0435\u043F\u0440\u0438\u043C\u0435\u043D\u0438\u043C\u0430 \u2014 \u043F\u0440\u043E\u0441\u0442\u043E
   * \u043E\u0442\u0431\u0440\u0430\u0441\u044B\u0432\u0430\u0435\u043C \u043F\u0443\u0441\u0442\u044B\u0435 \u0441\u0442\u0440\u043E\u043A\u0438 \u0438 \u043F\u0435\u0440\u0435\u0432\u043E\u0434\u044B \u0441\u0442\u0440\u043E\u043A \u0432\u043D\u0443\u0442\u0440\u0438 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u044F.
   */
  writeObjectNamesFile(operationId: string, fullNames: readonly string[]): string {
    const listPath = path.join(this.getAgentFileRoot(), 'lists', `${sanitizePathPart(operationId)}.txt`);
    fs.mkdirSync(path.dirname(listPath), { recursive: true });
    const normalized = fullNames
      .map((name) => name.replace(/[\r\n]+/g, ' ').trim())
      .filter(Boolean);
    fs.writeFileSync(listPath, `\uFEFF${normalized.join('\n')}`, 'utf-8');
    return listPath;
  }

  getAgentRoot(): string {
    return path.join(this.projectRoot, '.v8vscedit', 'agent');
  }

  getAgentFileRoot(): string {
    return path.join(this.getAgentRoot(), '0');
  }

  toAgentPath(localPath: string): string {
    const relative = path.relative(this.getAgentFileRoot(), localPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Путь агента должен находиться внутри проекта: ${localPath}`);
    }
    return relative.split(path.sep).join('/');
  }
}

function requireExtensionName(target: AgentConfigurationTarget): string {
  const name = target.extensionName?.trim();
  if (!name) {
    throw new Error('Для агентской операции с расширением требуется имя расширения.');
  }
  return name;
}

function sanitizePathPart(value: string): string {
  const result = value.trim().replace(/[^\p{L}\p{N}._-]+/gu, '_');
  if (!result || result === '.' || result === '..') {
    throw new Error(`Некорректный сегмент пути агента: ${value}`);
  }
  return result;
}

function normalizeRelativeFilePath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/').trim();
  if (!normalized || path.isAbsolute(normalized)) {
    throw new Error('Пути в list-файле агента должны быть относительными.');
  }

  const parts = normalized.split('/').filter(Boolean);
  if (parts.some((part) => part === '..')) {
    throw new Error('Путь list-файла агента не должен выходить за пределы каталога выгрузки.');
  }

  return parts.join('/');
}
