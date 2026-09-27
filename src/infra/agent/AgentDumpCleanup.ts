import * as fs from 'fs';
import * as path from 'path';
import { isStale, readDirOrEmptyAsync } from '../fs/WorkspaceTempDir';
import { AgentWorkspaceService } from './AgentWorkspaceService';

/**
 * Одноразовые выгрузки в режиме агента: сессия `<ключ>-dump-<мс>-<номер>` даёт каталог
 * `workspace/<сессия>` и (для частичной выгрузки) `lists/<сессия>.txt`. Имя строит и
 * разбирает только этот модуль: подметание не должно задеть постоянное зеркало
 * `workspace/<ключ>` для частичных загрузок.
 */

const AGENT_DUMP_NAME = /-dump-(\d+)-\d+(?:\.txt)?$/;

export function buildAgentDumpSessionId(sessionKey: string, startedAtMs: number, sequence: number): string {
  return `${sessionKey}-dump-${String(startedAtMs)}-${String(sequence)}`;
}

function parseAgentDumpStamp(name: string): number | undefined {
  const match = AGENT_DUMP_NAME.exec(name);
  return match ? Number(match[1]) : undefined;
}

/**
 * Удаляет выгрузки агента старше `maxAgeMs` — хвосты аварийно прерванных потоков
 * (штатно их удаляет `dispose()` дескриптора выгрузки). Возраст — из метки в имени,
 * а не из mtime: копирование рабочей области mtime меняет. Имена без метки не
 * трогаются.
 */
export async function pruneStaleAgentDumps(projectRoot: string, now: Date, maxAgeMs: number): Promise<string[]> {
  const agentFileRoot = new AgentWorkspaceService(projectRoot).getAgentFileRoot();
  const nowMs = now.getTime();
  const removed: string[] = [];
  const locations: readonly { dir: string; isEntry: (entry: fs.Dirent) => boolean }[] = [
    { dir: path.join(agentFileRoot, 'workspace'), isEntry: (entry) => entry.isDirectory() },
    { dir: path.join(agentFileRoot, 'lists'), isEntry: (entry) => entry.isFile() && entry.name.endsWith('.txt') },
  ];
  for (const location of locations) {
    for (const entry of await readDirOrEmptyAsync(location.dir)) {
      const stamp = location.isEntry(entry) ? parseAgentDumpStamp(entry.name) : undefined;
      if (stamp !== undefined && isStale(stamp, nowMs, maxAgeMs)) {
        const target = path.join(location.dir, entry.name);
        await fs.promises.rm(target, { recursive: true, force: true });
        removed.push(target);
      }
    }
  }
  return removed;
}
