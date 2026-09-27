import { CRS_OBJECTS_STATISTIC_PARAMS } from '../xml/CrsMessageXml';
import { parseCrsAddress } from './crs/CrsAddress';
import { callCrs } from './crs/CrsClient';
import { CRS_DEFAULT_TRANSPORT_OPTIONS, sendCrsRequest, type CrsTransportOptions } from './crs/CrsTransport';
import {
  RepositoryLockStatusError,
  type RepositoryLocation,
  type RepositoryLockReadContext,
  type RepositoryLockReadResult,
  type RepositoryLockStatusSource,
  type RepositoryServerLockRecord,
} from './RepositoryLockStatusSource';

/**
 * Сервер хранилища (tcp/http/https): один вызов `DevDepot_devObjectsStatistic` — статистика
 * всех объектов с признаком захвата, держателем и временем захвата. Только чтение: база и
 * Конфигуратор не нужны, привязка (`crs:bind`) не передаётся.
 */
export class NetworkRepositoryLockStatusSource implements RepositoryLockStatusSource {
  private readonly options: CrsTransportOptions;

  constructor(options: Partial<CrsTransportOptions> = {}) {
    this.options = { ...CRS_DEFAULT_TRANSPORT_OPTIONS, ...options };
  }

  supports(location: RepositoryLocation): boolean {
    return location.kind === 'server';
  }

  async readLocks(location: RepositoryLocation, context: RepositoryLockReadContext): Promise<RepositoryLockReadResult> {
    if (location.kind !== 'server') {
      throw new RepositoryLockStatusError('invalid-address', `Адрес ${location.repoPath} не является адресом сервера хранилища.`);
    }
    const address = parseCrsAddress(location.repoPath);
    const { response, serverVersion } = await callCrs(address, {
      method: 'DevDepot_devObjectsStatistic',
      paramsXml: CRS_OBJECTS_STATISTIC_PARAMS,
      user: context.user,
      password: context.password,
      versionHint: context.platformVersionHint,
    }, (target, body) => sendCrsRequest(target, body, this.options));
    // Держатель — по списку пользователей ответа; захват неизвестного пользователя не выводится.
    const records: RepositoryServerLockRecord[] = [];
    for (const [userId, user] of response.users) {
      for (const item of response.statistics) {
        if (item.revised && item.revisorId === userId) {
          records.push({ objectId: item.objectId, user, lockedAt: item.reviseDate });
        }
      }
    }
    return { records, serverVersion };
  }
}
