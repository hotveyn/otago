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
    busyStructural:
      'Узлы перемещаются, переименовываются или удаляются. Попробуйте через мгновение.',
    busyStreaming: 'Ответ ещё генерируется. Попробуйте, когда он завершится.',
    busyStreamingCount_one:
      'В этом дереве ещё генерируется {{count}} ответ. Попробуйте, когда он завершится, или отмените его.',
    busyStreamingCount_few:
      'В этом дереве ещё генерируются {{count}} ответа. Попробуйте, когда они завершатся, или отмените их.',
    busyStreamingCount_many:
      'В этом дереве ещё генерируются {{count}} ответов. Попробуйте, когда они завершатся, или отмените их.',
    busyStreamingCount_other:
      'В этом дереве ещё генерируются {{count}} ответа. Попробуйте, когда они завершатся, или отмените их.',
    nodeMissing:
      'Узел, от которого ответвляется этот чат, больше не существует (перемещён или удалён).',
    parentMissing: 'Узла, под которым задаётся вопрос, больше нет (перемещён или удалён).',
    questionNotFound: 'Этот вопрос больше недоступен.',
    questionFinished: 'Ответ уже сохранён.',
  },
  notices: {
    cancelledElsewhere: '«{{title}}» отменён в другой вкладке.',
    dismissedElsewhere: '«{{title}}» убран в другой вкладке.',
    expired: '«{{title}}» больше недоступен.',
    parentDeleted: '«{{title}}» убран: его узел удалён.',
    vanished: '«{{title}}» больше не выполняется.',
    serverRestarted_one: 'Сервер перезапустился: потерян {{count}} ответ в процессе.',
    serverRestarted_few: 'Сервер перезапустился: потеряны {{count}} ответа в процессе.',
    serverRestarted_many: 'Сервер перезапустился: потеряно {{count}} ответов в процессе.',
    serverRestarted_other: 'Сервер перезапустился: потеряно {{count}} ответа в процессе.',
    notSent: '«{{title}}» не отправлен: {{message}}',
  },
} satisfies Messages<typeof en>;
