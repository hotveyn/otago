import type { Messages } from '../../types';
import type { app as en } from '../en/app';

export const app = {
  emptyTitle: 'Выберите дерево или создайте новое.',
  emptyHint: 'Каждый вопрос становится узлом. Ветвитесь где угодно.',
  sideChat: 'Боковой чат',
  resizeChat: 'Изменить ширину чата',
  resizeSideChat: 'Изменить ширину бокового чата',
  splitterHint: 'Перетащите, чтобы изменить ширину · двойной клик — сбросить',
} satisfies Messages<typeof en>;
