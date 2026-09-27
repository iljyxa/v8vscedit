import * as assert from 'assert';
import { CRS_DEFAULT_ALIAS, CRS_DEFAULT_TCP_PORT, parseCrsAddress, type CrsAddress } from '../../infra/repository/crs/CrsAddress';
import { RepositoryLockStatusError } from '../../infra/repository/RepositoryLockStatusSource';

/**
 * Адрес сервера хранилища: http(s) — POST на URL до `.1ccr`, alias — сегмент после него
 * (без хвоста — `maincr`); tcp — `tcp://host[:port]/<alias>`, порт по умолчанию 1542.
 */
suite('parseCrsAddress (issue #6)', () => {
  const valid: [string, CrsAddress][] = [
    ['http://h/repo/repo.1ccr', { transport: 'http', host: 'h', port: 80, requestPath: '/repo/repo.1ccr', alias: CRS_DEFAULT_ALIAS }],
    ['http://h/repo/repo.1ccr/other', { transport: 'http', host: 'h', port: 80, requestPath: '/repo/repo.1ccr', alias: 'other' }],
    ['HTTP://h/repo/REPO.1CCR/', { transport: 'http', host: 'h', port: 80, requestPath: '/repo/REPO.1CCR', alias: CRS_DEFAULT_ALIAS }],
    ['https://h:8443/r.1ccr', { transport: 'https', host: 'h', port: 8443, requestPath: '/r.1ccr', alias: CRS_DEFAULT_ALIAS }],
    ['https://h/r.1ccr', { transport: 'https', host: 'h', port: 443, requestPath: '/r.1ccr', alias: CRS_DEFAULT_ALIAS }],
    ['tcp://h/alias', { transport: 'tcp', host: 'h', port: CRS_DEFAULT_TCP_PORT, requestPath: '', alias: 'alias' }],
    ['tcp://h:17542/alias', { transport: 'tcp', host: 'h', port: 17542, requestPath: '', alias: 'alias' }],
    ['tcp://[::1]:17542/Хранилище/', { transport: 'tcp', host: '::1', port: 17542, requestPath: '', alias: 'Хранилище' }],
  ];
  for (const [repoPath, expected] of valid) {
    test(`${repoPath} → ${expected.transport} ${expected.host}:${String(expected.port)} alias ${expected.alias}`, () => {
      assert.deepStrictEqual(parseCrsAddress(repoPath), expected);
    });
  }

  const invalid = ['tcp://h', 'tcp://h/', 'ftp://h/r.1ccr', 'http://h/repo/', 'http://[bad'];
  for (const repoPath of invalid) {
    test(`${repoPath} → invalid-address`, () => {
      assert.throws(() => parseCrsAddress(repoPath), (error: unknown) =>
        error instanceof RepositoryLockStatusError && error.code === 'invalid-address' && error.message.includes(repoPath));
    });
  }
});
