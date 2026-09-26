import type { Messages } from '../../types';
import type { common as en } from '../en/common';

export const common = {
  loading: 'Загрузка…',
  cancel: 'Отмена',
  create: 'Создать',
  delete: 'Удалить',
  close: 'Закрыть',
  dismiss: 'Скрыть',
  download: 'Скачать',
  preview: 'Просмотр',
  source: 'Исходник',
  root: 'корень',
  line: 'строка {{start}}',
  lines: 'строки {{start}}–{{end}}',
  errors: {
    busyStructural: 'Узлы перемещаются или удаляются. Попробуйте через мгновение.',
    busyStreaming: 'Ответ ещё генерируется. Попробуйте, когда он завершится.',
    nodeMissing:
      'Узел, от которого ответвляется этот чат, больше не существует (перемещён или удалён).',
    emptyResponse: 'Пустой ответ',
    streamEnded: 'Поток завершился без ответа',
  },
} satisfies Messages<typeof en>;
