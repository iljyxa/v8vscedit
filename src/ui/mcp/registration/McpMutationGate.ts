/**
 * Единый post-mutation шлюз и общие формат-хелперы MCP-инструментов.
 *
 * Выделено из `V8McpServer` при декомпозиции God-класса `registerTools`:
 * все доменные модули регистрации (`registration/*`) используют ОДИН и тот же
 * gate, а не собственные копии проверок блокировки и пост-мутационного пути.
 *
 * `McpMutationGate` держит ссылку на `services` и повторяет поведение, ранее
 * жившее в приватных методах `V8McpServer` (`afterMutation`,
 * `afterMutationIfSucceeded`, `assertMetadataEditable`, `assertNodeEditable`,
 * `ok`/`wrap`/`wrapAsync`/`toolError`) — байт-в-байт по логике.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { SupportMode } from '../../../infra/support/SupportInfoService';
import type { CommandServices } from '../../commands/_shared';
import type { MetadataNode } from '../../tree/TreeNode';
import { CHANGES_FORBIDDEN_REASON } from '../../support/supportLockReason';
import { resolveRepositoryEditProbePath } from '../../views/properties/propertyEditLock';

type McpCommandServices = Omit<CommandServices, 'aiMcpViewProvider'>;

/**
 * Общий шлюз мутаций и формат-хелперы, разделяемые всеми доменными модулями
 * регистрации MCP-инструментов.
 */
export class McpMutationGate {
  constructor(private readonly services: McpCommandServices) {}

  ok(data: unknown): CallToolResult {
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    };
  }

  wrap(fn: () => unknown): CallToolResult {
    try {
      return this.ok(fn());
    } catch (error) {
      return this.toolError(error);
    }
  }

  async wrapAsync(fn: () => Promise<unknown>): Promise<CallToolResult> {
    try {
      return this.ok(await fn());
    } catch (error) {
      return this.toolError(error);
    }
  }

  toolError(error: unknown): CallToolResult {
    const message = error instanceof Error ? error.message : String(error);
    return {
      isError: true,
      content: [{ type: 'text', text: message }],
    };
  }

  /**
   * Перед мутацией существующего объекта повторяет проверки UI: объект на
   * поддержке без права редактирования (`SupportMode.Locked`) или не захвачен
   * в подключённом хранилище конфигурации блокируется. Защищает .cf-объекты;
   * для объектов вне поддержки/хранилища обе проверки возвращают «разрешено».
   *
   * `objectXmlPath` — XML-файл объекта-владельца (для дочерних элементов это
   * `metaContext.ownerObjectXmlPath`), как и в `RemoveMetadataCommand` /
   * `PropertiesViewController`. Поддержка всегда проверяется по нему.
   *
   * `repositoryProbePath` — файл, по которому определяется единица хранилища;
   * для содержимого формы/макета это их собственный XML (захват единицы
   * независим от владельца). Если не задан — проверяется `objectXmlPath`.
   */
  assertMetadataEditable(objectXmlPath: string | undefined, repositoryProbePath?: string): void {
    if (!objectXmlPath) {
      throw new Error('Не удалось определить XML-файл объекта для проверки блокировки изменения.');
    }
    if (this.services.supportService?.getSupportMode(objectXmlPath) === SupportMode.Locked) {
      if (this.services.supportService.hasChangesForbidden(objectXmlPath)) {
        throw new Error(`Объект защищён от изменения: ${CHANGES_FORBIDDEN_REASON}.`);
      }
      throw new Error('Объект защищён от изменения: находится на поддержке с запретом редактирования.');
    }
    if (this.services.repositoryService.isEditRestricted(repositoryProbePath ?? objectXmlPath)) {
      throw new Error('Объект защищён от изменения: не захвачен в хранилище конфигурации.');
    }
  }

  /**
   * Резолвит путь объекта-владельца у узла дерева так же, как UI
   * (`metaContext.ownerObjectXmlPath ?? xmlPath`) и проверяет блокировку.
   * Граница — СОСТАВ владельца (добавление/удаление/переименование дочернего
   * элемента меняет XML владельца), поэтому хранилище проверяется по владельцу
   * даже для формы/макета.
   */
  assertNodeEditable(node: MetadataNode): void {
    this.assertMetadataEditable(node.metaContext?.ownerObjectXmlPath ?? node.xmlPath);
  }

  /**
   * Граница — СОДЕРЖИМОЕ самого узла (свойства, тип, тело формы/макета). Поддержка
   * проверяется по владельцу, хранилище — по единице узла так же, как панель
   * свойств (`resolveRepositoryEditProbePath`): форма/макет объекта захватываются
   * отдельно от владельца.
   */
  assertNodeContentEditable(node: MetadataNode): void {
    this.assertMetadataEditable(node.metaContext?.ownerObjectXmlPath ?? node.xmlPath, resolveRepositoryEditProbePath(node));
  }

  afterMutation(filePaths: readonly string[]): void {
    if (filePaths.length === 0) {
      return;
    }
    this.services.suppressConfigurationReloadForFiles([...filePaths]);
    this.services.markChangedConfigurationByFiles([...filePaths]);
    // refreshCacheForFiles сам эмитит onDidChangeTreeData (точечно для изменённых
    // узлов или полным refresh внутри). Дополнительный refresh() дублировал бы
    // работу — десятки тысяч new MetadataNode на больших конфигурациях. Делаем
    // его только если refreshCacheForFiles ничего не обновил (нет совпавших
    // конфигураций — например, файлы вне дерева).
    const refreshed = this.services.treeProvider.refreshCacheForFiles([...filePaths]);
    if (!refreshed) {
      this.services.treeProvider.refresh();
    }
    this.services.refreshActionsView();
  }

  /**
   * Единый guarded-шлюз post-mutation (Волна 5b, M8). Гейт по факту успеха
   * мутации: если результат помечен неуспешным (`succeeded === false`),
   * конфигурация НЕ помечается изменённой и дерево НЕ рефрешится — иначе при
   * частичном провале UI зря считал бы конфигурацию грязной. Формы результата,
   * не несущие явного `success` (сервис сигналит провал исключением внутри
   * `wrap`/`wrapAsync`), проходят с `succeeded=true`, а фактический гейт для них
   * даёт пустой список изменённых файлов (см. `afterMutation`).
   */
  afterMutationIfSucceeded(changedFiles: readonly string[] | undefined, succeeded = true): void {
    if (!succeeded) {
      return;
    }
    const files = changedFiles ?? [];
    if (files.length === 0) {
      return;
    }
    this.afterMutation([...files]);
  }
}
