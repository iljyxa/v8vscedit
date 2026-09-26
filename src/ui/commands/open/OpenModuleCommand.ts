import * as vscode from 'vscode';
import {
  ensureCommandModulePathForChild,
  ensureCommonCommandModulePath,
  ensureCommonFormModulePath,
  ensureCommonModuleFile,
  ensureConstantModulePath,
  ensureFormModulePathForChild,
  ensureManagerModulePath,
  ensureObjectModulePath,
  ensureRecordSetModulePath,
  ensureServiceModulePath,
  getCommonCommandModulePath,
  getCommonFormModulePath,
  getCommandModulePathForChild,
  getCommonModuleCodePath,
  getConstantModulePath,
  getFormModulePathForChild,
  getManagerModulePath,
  getObjectModulePath,
  getRecordSetModulePath,
  getServiceModulePath,
} from '../../../infra/fs/MetaPathResolver';
import { MetadataNode } from '../../tree/TreeNode';
import type { CommandServices, NodeArg } from '../_shared';
import { resolveRepositoryEditProbePath } from '../../views/properties/propertyEditLock';
import { setEditorReadonly } from './OpenXmlCommand';

/** Регистрирует команды открытия BSL-модулей для всех слотов. */
export function registerOpenModuleCommands(
  context: vscode.ExtensionContext,
  services: CommandServices
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('v8vscedit.openCommonModuleCode', async (node: NodeArg, options?: OpenModuleOptions) => {
      const modulePath = await resolveModuleForOpen(
        services,
        node,
        getCommonModuleCodePath,
        ensureCommonModuleFile,
        'общего модуля'
      );
      if (!modulePath) {
        return;
      }

      await openModule(services, modulePath, node, options);
    }),

    vscode.commands.registerCommand('v8vscedit.openObjectModule', async (node: NodeArg, options?: OpenModuleOptions) => {
      const modulePath = await resolveModuleForOpen(
        services,
        node,
        getObjectModulePath,
        ensureObjectModulePath,
        'модуля объекта'
      );
      if (!modulePath) {
        return;
      }

      await openModule(services, modulePath, node, options);
    }),

    vscode.commands.registerCommand('v8vscedit.openManagerModule', async (node: NodeArg, options?: OpenModuleOptions) => {
      const modulePath = await resolveModuleForOpen(
        services,
        node,
        getManagerModulePath,
        ensureManagerModulePath,
        'модуля менеджера'
      );
      if (!modulePath) {
        return;
      }

      await openModule(services, modulePath, node, options);
    }),

    vscode.commands.registerCommand('v8vscedit.openRecordSetModule', async (node: NodeArg, options?: OpenModuleOptions) => {
      const modulePath = await resolveModuleForOpen(
        services,
        node,
        getRecordSetModulePath,
        ensureRecordSetModulePath,
        'модуля записи'
      );
      if (!modulePath) {
        return;
      }

      await openModule(services, modulePath, node, options);
    }),

    vscode.commands.registerCommand('v8vscedit.openConstantModule', async (node: NodeArg, options?: OpenModuleOptions) => {
      const modulePath = await resolveModuleForOpen(
        services,
        node,
        getConstantModulePath,
        ensureConstantModulePath,
        'модуля менеджера значения'
      );
      if (!modulePath) {
        return;
      }

      await openModule(services, modulePath, node, options);
    }),

    vscode.commands.registerCommand('v8vscedit.openServiceModule', async (node: NodeArg, options?: OpenModuleOptions) => {
      const modulePath = await resolveModuleForOpen(
        services,
        node,
        getServiceModulePath,
        ensureServiceModulePath,
        'модуля сервиса'
      );
      if (!modulePath) {
        return;
      }

      await openModule(services, modulePath, node, options);
    }),

    vscode.commands.registerCommand('v8vscedit.openFormModule', async (node: NodeArg, options?: OpenModuleOptions) => {
      const isCommonForm = node.nodeKind === 'CommonForm';
      const modulePath = isCommonForm
        ? await resolveModuleForOpen(
          services,
          node,
          getCommonFormModulePath,
          ensureCommonFormModulePath,
          'модуля общей формы'
        )
        : await resolveModuleForOpen(
          services,
          node,
          getFormModulePathForChild,
          ensureFormModulePathForChild,
          'модуля формы'
        );
      if (!modulePath) {
        return;
      }

      await openModule(services, modulePath, node, options);
    }),

    vscode.commands.registerCommand('v8vscedit.openCommandModule', async (node: NodeArg, options?: OpenModuleOptions) => {
      const isCommonCommand = node.nodeKind === 'CommonCommand';
      const modulePath = isCommonCommand
        ? await resolveModuleForOpen(
          services,
          node,
          getCommonCommandModulePath,
          ensureCommonCommandModulePath,
          'модуля общей команды'
        )
        : await resolveModuleForOpen(
          services,
          node,
          getCommandModulePathForChild,
          ensureCommandModulePathForChild,
          'модуля команды'
        );
      if (!modulePath) {
        return;
      }

      await openModule(services, modulePath, node, options);
    })
  );
}

interface OpenModuleOptions {
  readonly preview?: boolean;
  readonly preserveFocus?: boolean;
}

type ModulePathResolver = (node: { xmlPath?: string; kind?: string; label?: string }) => string | null;

async function resolveModuleForOpen(
  services: CommandServices,
  node: NodeArg,
  resolveExisting: ModulePathResolver,
  ensureMissing: ModulePathResolver,
  moduleLabel: string
): Promise<string | null> {
  const info = toNodePathInfo(node);
  const existing = resolveExisting(info);
  if (existing) {
    return existing;
  }

  if (isModuleEditLocked(services, node)) {
    await vscode.window.showWarningMessage(`Нельзя создать файл ${moduleLabel}: объект заблокирован для редактирования.`);
    return null;
  }

  try {
    const created = ensureMissing(info);
    if (!created) {
      await vscode.window.showWarningMessage(`Не удалось определить путь ${moduleLabel}.`);
      return null;
    }
    return created;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await vscode.window.showErrorMessage(`Не удалось создать файл ${moduleLabel}: ${message}`);
    return null;
  }
}

/**
 * Поддержка решается по XML владельца, а хранилище — по файлу единицы узла
 * (`resolveRepositoryEditProbePath`): форма объекта захватывается отдельно от
 * владельца (#45/#46), и проверка по владельцу открывала бы модуль захваченной
 * формы только для чтения. Узлы вне дерева (без `MetadataNode`) адресуются своим
 * `xmlPath`, как раньше.
 */
function isModuleEditLocked(services: CommandServices, node: NodeArg): boolean {
  const ownerXmlPath = node.xmlPath;
  const supportLocked = ownerXmlPath ? services.supportService?.isLocked(ownerXmlPath) ?? false : false;
  const repositoryProbePath = node instanceof MetadataNode ? resolveRepositoryEditProbePath(node) : ownerXmlPath;
  const repositoryLocked = repositoryProbePath ? services.repositoryService.isEditRestricted(repositoryProbePath) : false;
  return supportLocked || repositoryLocked;
}

async function openModule(
  services: CommandServices,
  modulePath: string,
  node: NodeArg,
  options?: { preview?: boolean; preserveFocus?: boolean }
): Promise<void> {
  const locked = isModuleEditLocked(services, node);
  const editor = await vscode.window.showTextDocument(vscode.Uri.file(modulePath), {
    preview: options?.preview ?? true,
    preserveFocus: options?.preserveFocus ?? false,
  });

  if (locked) {
    await setEditorReadonly(editor);
  }
}

function toNodePathInfo(node: NodeArg): { xmlPath?: string; kind?: string; label?: string } {
  if (node instanceof MetadataNode) {
    return {
      xmlPath: node.xmlPath,
      kind: node.nodeKind,
      label: node.textLabel,
    };
  }

  return {
    xmlPath: node.xmlPath,
    kind: node.nodeKind,
    label: typeof node.label === 'string' ? node.label : undefined,
  };
}
