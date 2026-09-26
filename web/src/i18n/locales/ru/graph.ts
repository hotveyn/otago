import type { Messages } from '../../types';
import type { graph as en } from '../en/graph';

export const graph = {
  ghostTitle: 'Здесь появится следующий ответ',
  rootTitle: 'Корень дерева',
  selected: 'Выбрано: {{count}}',
  inside: '(внутри: {{count}})',
  moveTo: 'Переместить…',
  clear: 'Сбросить',
  hint: 'Клик — открыть · Shift/⌘-клик — выбрать · перетащите на узел, чтобы переместить',
  busy: 'Идёт ответ… изменения приостановлены',
  delete: {
    title_one: 'Удалить {{count}} узел',
    title_few: 'Удалить {{count}} узла',
    title_many: 'Удалить {{count}} узлов',
    title_other: 'Удалить {{count}} узла',
    confirm: 'Удалить {{count}}',
    deleting: 'Удаление…',
    body_one:
      'Будет безвозвратно удалён <strong>{{count}}</strong> узел. Резервная копия — только Git.',
    body_few:
      'Будут безвозвратно удалены <strong>{{count}}</strong> узла. Резервная копия — только Git.',
    body_many:
      'Будут безвозвратно удалены <strong>{{count}}</strong> узлов. Резервная копия — только Git.',
    body_other:
      'Будут безвозвратно удалены <strong>{{count}}</strong> узла. Резервная копия — только Git.',
    bodyNested_one:
      'Будет безвозвратно удалён <strong>{{count}}</strong> узел (выбрано {{selected}} + {{descendants}}). Резервная копия — только Git.',
    bodyNested_few:
      'Будут безвозвратно удалены <strong>{{count}}</strong> узла (выбрано {{selected}} + {{descendants}}). Резервная копия — только Git.',
    bodyNested_many:
      'Будут безвозвратно удалены <strong>{{count}}</strong> узлов (выбрано {{selected}} + {{descendants}}). Резервная копия — только Git.',
    bodyNested_other:
      'Будут безвозвратно удалены <strong>{{count}}</strong> узла (выбрано {{selected}} + {{descendants}}). Резервная копия — только Git.',
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
} satisfies Messages<typeof en>;
