import type { Messages } from '../../types';
import type { viewer as en } from '../en/viewer';

export const viewer = {
  sourceLabel: 'Источник {{name}}',
  fileLabel: 'Файл {{name}}',
  attachmentLabel: 'Вложение {{name}}',
  lines: 'Строки',
  rendered: 'Отрисовка',
  book: 'Книга ↓',
  raw: 'Исходный ↗',
  open: 'Открыть ↗',
  closeSource: 'Закрыть источник',
  closeAttachment: 'Закрыть вложение',
  tooLarge: 'Слишком большой для просмотра.',
  noPreview: 'Для этого типа файлов нет предпросмотра.',
  couldNotParse: 'Не удалось разобрать;',
  previewAsText: 'Показать как текст',
} satisfies Messages<typeof en>;
