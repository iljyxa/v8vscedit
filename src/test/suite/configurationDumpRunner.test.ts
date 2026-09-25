import * as assert from 'assert';
import { buildExportToTempCliArgs } from '../../ui/commands/ext/ConfigurationDumpRunner';

/**
 * `buildExportToTempCliArgs` — чистая сборка аргументов для уже существующего
 * внутреннего CLI `export-configuration` (`cli/commands/export-configuration.ts`,
 * см. `ExtensionCommandRunner.runBatchPartialDump` — тот же `-ProjectRoot/-Target/
 * -ConfigDir/-Mode/-Objects/-Extension` конвейер, только с новыми значениями `-Mode`
 * `UpdateInfo`/`Full` вместо единственного прежнего `Partial`). Реальный запуск
 * процесса (`dumpConfigurationToTemp`) не тестируется здесь — согласно плану
 * архитектора это единственная сознательно помеченная c8-ignore ветка нового
 * файла (внешний процесс, недоступный в CI).
 */
suite('ConfigurationDumpRunner — buildExportToTempCliArgs', () => {
  const cfTarget = { kind: 'cf' as const, name: 'ТорговыйУчет', rootPath: '/proj/src/cf' };
  const cfeTarget = { kind: 'cfe' as const, name: 'EVOLC', rootPath: '/proj/src/cfe/EVOLC', extensionName: 'EVOLC' };
  const connectionArgs = ['-S', 'server/ref', '-N', 'user'];

  test('mode "partial" (cf): -Mode Partial + -Objects из fullNames через запятую, без -Extension', () => {
    const args = buildExportToTempCliArgs(
      cfTarget,
      { mode: 'partial', fullNames: ['Справочник.Товары', 'Документ.Заказ'] },
      '/tmp/dump-1',
      '/proj',
      connectionArgs
    );
    assert.deepStrictEqual(args, [
      'export-configuration',
      '-ProjectRoot', '/proj',
      '-Target', 'cf',
      '-ConfigDir', '/tmp/dump-1',
      '-Mode', 'Partial',
      '-Objects', 'Справочник.Товары,Документ.Заказ',
      '-S', 'server/ref',
      '-N', 'user',
    ]);
  });

  test('mode "partial" (cfe): дополнительно вставляется -Extension перед аргументами подключения', () => {
    const args = buildExportToTempCliArgs(
      cfeTarget,
      { mode: 'partial', fullNames: ['Справочник.Товары'] },
      '/tmp/dump-2',
      '/proj',
      connectionArgs
    );
    assert.deepStrictEqual(args, [
      'export-configuration',
      '-ProjectRoot', '/proj',
      '-Target', 'cfe',
      '-ConfigDir', '/tmp/dump-2',
      '-Mode', 'Partial',
      '-Objects', 'Справочник.Товары',
      '-Extension', 'EVOLC',
      '-S', 'server/ref',
      '-N', 'user',
    ]);
  });

  test('mode "update-info" (cf): -Mode UpdateInfo, без -Objects', () => {
    const args = buildExportToTempCliArgs(cfTarget, { mode: 'update-info' }, '/tmp/dump-3', '/proj', connectionArgs);
    assert.deepStrictEqual(args, [
      'export-configuration',
      '-ProjectRoot', '/proj',
      '-Target', 'cf',
      '-ConfigDir', '/tmp/dump-3',
      '-Mode', 'UpdateInfo',
      '-S', 'server/ref',
      '-N', 'user',
    ]);
  });

  test('mode "update-info" (cfe): -Extension присутствует, -Objects отсутствует', () => {
    const args = buildExportToTempCliArgs(cfeTarget, { mode: 'update-info' }, '/tmp/dump-4', '/proj', connectionArgs);
    assert.deepStrictEqual(args, [
      'export-configuration',
      '-ProjectRoot', '/proj',
      '-Target', 'cfe',
      '-ConfigDir', '/tmp/dump-4',
      '-Mode', 'UpdateInfo',
      '-Extension', 'EVOLC',
      '-S', 'server/ref',
      '-N', 'user',
    ]);
  });

  test('mode "full" (cf): -Mode Full, без -Objects', () => {
    const args = buildExportToTempCliArgs(cfTarget, { mode: 'full' }, '/tmp/dump-5', '/proj', connectionArgs);
    assert.deepStrictEqual(args, [
      'export-configuration',
      '-ProjectRoot', '/proj',
      '-Target', 'cf',
      '-ConfigDir', '/tmp/dump-5',
      '-Mode', 'Full',
      '-S', 'server/ref',
      '-N', 'user',
    ]);
  });

  test('mode "full" (cfe): -Extension присутствует', () => {
    const args = buildExportToTempCliArgs(cfeTarget, { mode: 'full' }, '/tmp/dump-6', '/proj', connectionArgs);
    assert.deepStrictEqual(args, [
      'export-configuration',
      '-ProjectRoot', '/proj',
      '-Target', 'cfe',
      '-ConfigDir', '/tmp/dump-6',
      '-Mode', 'Full',
      '-Extension', 'EVOLC',
      '-S', 'server/ref',
      '-N', 'user',
    ]);
  });

  test('partial с пустым fullNames — -Objects всё равно передаётся пустой строкой (вызывающая сторона отвечает за непустоту списка)', () => {
    const args = buildExportToTempCliArgs(cfTarget, { mode: 'partial', fullNames: [] }, '/tmp/dump-7', '/proj', []);
    assert.deepStrictEqual(args, [
      'export-configuration',
      '-ProjectRoot', '/proj',
      '-Target', 'cf',
      '-ConfigDir', '/tmp/dump-7',
      '-Mode', 'Partial',
      '-Objects', '',
    ]);
  });

  test('пустой connectionArgs не добавляет лишних элементов', () => {
    const args = buildExportToTempCliArgs(cfTarget, { mode: 'full' }, '/tmp/dump-8', '/proj', []);
    assert.deepStrictEqual(args, [
      'export-configuration',
      '-ProjectRoot', '/proj',
      '-Target', 'cf',
      '-ConfigDir', '/tmp/dump-8',
      '-Mode', 'Full',
    ]);
  });
});
