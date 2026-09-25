import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RoleRightsEditService } from '../../infra/role/RoleRightsEditService';
import { ConfigurationScaffoldService, MetadataXmlCreator } from '../../infra/xml';

/**
 * role-edit пересериализует Rights.xml целиком (iljyxa/v8vscedit#30), поэтому сериализатор
 * обязан воспроизводить выгрузку платформы: `xsi:type="Rights"` у корня, без перевода строки
 * после `</Rights>`; BOM и CRLF сохраняет запись. Проверяется на всех ролях example/2.20 и 2.21.
 */

const EXAMPLE_ROOT = path.resolve(__dirname, '../../../example');
const ROLES = ['Администратор', 'Кладовщик', 'Продавец'] as const;

function copyRights(version: '2.20' | '2.21', role: string): { readonly rightsPath: string; readonly original: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-role-roundtrip-'));
  const rightsPath = path.join(root, 'Roles', role, 'Ext', 'Rights.xml');
  fs.mkdirSync(path.dirname(rightsPath), { recursive: true });
  fs.copyFileSync(path.join(EXAMPLE_ROOT, version, 'src', 'cf', 'Roles', role, 'Ext', 'Rights.xml'), rightsPath);
  return { rightsPath, original: fs.readFileSync(rightsPath, 'utf-8') };
}

function readSetForNewObjects(xml: string): boolean {
  const match = /<setForNewObjects>(true|false)<\/setForNewObjects>/.exec(xml);
  assert.ok(match, 'в фикстуре нет setForNewObjects');
  return match[1] === 'true';
}

suite('RoleRightsEditService.edit — Rights.xml реальной выгрузки переживает пересериализацию (#30)', () => {
  for (const version of ['2.20', '2.21'] as const) {
    for (const role of ROLES) {
      suite(`${version}/${role}`, () => {
        test('контроль фикстуры: BOM, CRLF, xsi:type="Rights", без перевода строки в конце', () => {
          const { original } = copyRights(version, role);
          assert.ok(original.startsWith('﻿'));
          assert.ok(original.includes('\r\n'));
          assert.ok(original.includes(' xsi:type="Rights" '));
          assert.ok(original.endsWith('</Rights>'));
        });

        test('флаг уже имеет это значение: changed=false, changedFiles пуст, файл байт-в-байт прежний', () => {
          const { rightsPath, original } = copyRights(version, role);
          const current = readSetForNewObjects(original);

          const result = new RoleRightsEditService().edit({
            rightsPath,
            operations: [{ op: 'setFlags', flags: { setForNewObjects: current } }],
          });

          assert.strictEqual(result.success, true);
          assert.strictEqual(result.changed, false);
          assert.strictEqual(result.applied, 0);
          assert.deepStrictEqual(result.changedFiles, []);
          assert.strictEqual(fs.readFileSync(rightsPath, 'utf-8'), original);
        });

        test('смена флага меняет ровно одну строку, обратная смена возвращает исходник', () => {
          const { rightsPath, original } = copyRights(version, role);
          const current = readSetForNewObjects(original);
          const service = new RoleRightsEditService();

          const result = service.edit({
            rightsPath,
            operations: [{ op: 'setFlags', flags: { setForNewObjects: !current } }],
          });

          assert.strictEqual(result.changed, true);
          assert.deepStrictEqual(result.changedFiles, [rightsPath]);
          assert.strictEqual(
            fs.readFileSync(rightsPath, 'utf-8'),
            original.replace(
              `<setForNewObjects>${String(current)}</setForNewObjects>`,
              `<setForNewObjects>${String(!current)}</setForNewObjects>`
            )
          );

          service.edit({ rightsPath, operations: [{ op: 'setFlags', flags: { setForNewObjects: current } }] });
          assert.strictEqual(fs.readFileSync(rightsPath, 'utf-8'), original);
        });
      });
    }
  }
  test('роль, созданная расширением (MetadataXmlCreator): правка без изменений не переписывает Rights.xml', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-role-created-'));
    new ConfigurationScaffoldService().createConfiguration({ name: 'Конфигурация', outputDir: root });
    new MetadataXmlCreator().addRootObject({ configRoot: root, kind: 'Role', name: 'Тест' });
    const rightsPath = path.join(root, 'Roles', 'Тест', 'Ext', 'Rights.xml');
    const original = fs.readFileSync(rightsPath, 'utf-8');

    const result = new RoleRightsEditService().edit({
      rightsPath,
      operations: [{ op: 'setFlags', flags: { setForNewObjects: readSetForNewObjects(original) } }],
    });

    assert.strictEqual(result.changed, false);
    assert.deepStrictEqual(result.changedFiles, []);
    assert.strictEqual(fs.readFileSync(rightsPath, 'utf-8'), original);
  });
});
