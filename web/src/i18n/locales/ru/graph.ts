import type { Messages } from '../../types';
import type { graph as en } from '../en/graph';

export const graph = {
  ghostTitle: 'Здесь появится следующий ответ',
  rootTitle: 'Корень дерева',
  selected: 'Выбрано: {{count}}',
  inside: '(внутри: {{count}})',
  moveTo: 'Переместить…',
  clear: 'Сбросить',
  rename: 'Переименовать',
  hint: 'Клик — открыть · Shift/⌘-клик — выбрать · перетащите на узел, чтобы переместить · Ctrl/⌘+Z — отменить',
  busy: 'Идёт ответ… изменения приостановлены',
  delete: {
    title_one: 'Удалить {{count}} узел',
    title_few: 'Удалить {{count}} узла',
    title_many: 'Удалить {{count}} узлов',
    title_other: 'Удалить {{count}} узла',
    confirm: 'Удалить {{count}}',
    deleting: 'Удаление…',
    body_one: 'Будет удалён <strong>{{count}}</strong> узел. Его можно вернуть через Ctrl/⌘+Z.',
    body_few: 'Будут удалены <strong>{{count}}</strong> узла. Их можно вернуть через Ctrl/⌘+Z.',
    body_many: 'Будут удалены <strong>{{count}}</strong> узлов. Их можно вернуть через Ctrl/⌘+Z.',
    body_other: 'Будут удалены <strong>{{count}}</strong> узла. Их можно вернуть через Ctrl/⌘+Z.',
    bodyNested_one:
      'Будет удалён <strong>{{count}}</strong> узел (выбрано {{selected}} + {{descendants}}). Его можно вернуть через Ctrl/⌘+Z.',
    bodyNested_few:
      'Будут удалены <strong>{{count}}</strong> узла (выбрано {{selected}} + {{descendants}}). Их можно вернуть через Ctrl/⌘+Z.',
    bodyNested_many:
      'Будут удалены <strong>{{count}}</strong> узлов (выбрано {{selected}} + {{descendants}}). Их можно вернуть через Ctrl/⌘+Z.',
    bodyNested_other:
      'Будут удалены <strong>{{count}}</strong> узла (выбрано {{selected}} + {{descendants}}). Их можно вернуть через Ctrl/⌘+Z.',
    descendants_one: '{{count}} потомок',
    descendants_few: '{{count}} потомка',
    descendants_many: '{{count}} потомков',
    descendants_other: '{{count}} потомка',
  },
  move: {
    title_one: 'Переместить {{count}} узел',
    title_few: 'Переместить {{count}} узла',
    title_many: 'Переместить {{count}} узлов',
    title_other: 'Переместить {{count}} узла',
    confirm: 'Переместить сюда',
    moving: 'Перемещение…',
    hint: 'Выберите нового родителя. Потомки переместятся вместе с узлами.',
  },
  renameDialog: {
    title: 'Переименовать узел',
    label: 'Название',
    confirm: 'Переименовать',
    saving: 'Переименование…',
    hint: 'Название станет именем папки (строчные латинские буквы, дефисы). Если такое имя уже есть у соседнего узла, добавится «-2». Идентификаторы узла и его потомков изменятся.',
  },
  undo: {
    stale: 'Не удалось отменить: дерево с тех пор изменилось.',
    nodeMissing: 'Не удалось отменить: узел больше не существует.',
    parentMissing: 'Не удалось отменить: исходного родителя больше нет.',
    trashMissing: 'Не удалось отменить: удалённого узла больше нет в корзине.',
    treeMissing: 'Не удалось отменить: дерева больше нет.',
    invalid: 'Это изменение нельзя отменить.',
    failed: 'Не удалось отменить: {{message}}',
  },
} satisfies Messages<typeof en>;
