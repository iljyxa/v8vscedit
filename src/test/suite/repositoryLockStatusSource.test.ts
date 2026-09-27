import * as assert from 'assert';
import * as path from 'path';
import { classifyRepositoryLocation, RepositoryLockStatusError } from '../../infra/repository/RepositoryLockStatusSource';

/** Вид хранилища по адресу привязки: сервер (tcp/http/https, схема без учёта регистра) или файл 1CD. */
suite('classifyRepositoryLocation (issue #6)', () => {
  const workspaceRoot = path.resolve('/work/project');

  const servers: [string, 'tcp' | 'http' | 'https'][] = [
    ['tcp://srv/r', 'tcp'],
    ['TCP://srv/r', 'tcp'],
    ['http://h/repo.1ccr', 'http'],
    [' https://h/repo.1ccr/x ', 'https'],
  ];
  for (const [repoPath, transport] of servers) {
    test(`сервер: ${repoPath.trim()} → ${transport}`, () => {
      assert.deepStrictEqual(classifyRepositoryLocation(repoPath, workspaceRoot), { kind: 'server', repoPath: repoPath.trim(), transport });
    });
  }

  const files: [string, string, string][] = [
    ['абсолютный каталог', path.resolve('/srv/repo'), path.join(path.resolve('/srv/repo'), '1cv8ddb.1CD')],
    ['относительный каталог — от рабочей области', 'repo', path.join(workspaceRoot, 'repo', '1cv8ddb.1CD')],
    ['путь к .1CD', path.resolve('/srv/repo/1cv8ddb.1CD'), path.resolve('/srv/repo/1cv8ddb.1CD')],
    ['путь к .1cd в нижнем регистре', path.resolve('/srv/repo/base.1cd'), path.resolve('/srv/repo/base.1cd')],
  ];
  for (const [title, repoPath, databaseFile] of files) {
    test(`файл: ${title}`, () => {
      const location = classifyRepositoryLocation(repoPath, workspaceRoot);
      assert.ok(location.kind === 'file');
      assert.strictEqual(location.databaseFile, databaseFile);
    });
  }

  test('RepositoryLockStatusError хранит код и причину', () => {
    const cause = new Error('исходная');
    const error = new RepositoryLockStatusError('timeout', 'истекло', { cause });
    assert.deepStrictEqual([error.code, error.message, error.cause, error.name], ['timeout', 'истекло', cause, 'RepositoryLockStatusError']);
  });
});
