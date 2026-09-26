import type { Messages } from '../../types';
import type { sidebar as en } from '../en/sidebar';

export const sidebar = {
  brandSub: 'деревья знаний',
  expand: 'Развернуть панель',
  collapse: 'Свернуть панель',
  expandHint: 'Развернуть панель (Ctrl/⌘+B)',
  collapseHint: 'Свернуть панель (Ctrl/⌘+B)',
  trees: {
    title: 'Деревья',
    new: '+ Новое',
    empty: 'Деревьев пока нет.',
    titlePlaceholder: 'Название дерева, например «Основы Rust»',
  },
  settings: {
    title: 'Настройки',
    instructionsSet: 'инструкции заданы',
    fieldTitle: 'Название',
    fieldInstructions: 'Инструкции',
    instructionsPlaceholder: 'Отвечай по-русски. Я знаю C++, сравнивай с ним, где это полезно.',
    instructionsHint: 'Добавляются к системному промпту при каждом вопросе.',
    save: 'Сохранить',
    saving: 'Сохранение…',
    saved: 'Сохранено',
  },
  sources: {
    title: 'Источники',
    upload: '+ Загрузить',
    uploading: 'Загрузка…',
    empty:
      'Перетащите сюда файлы .md, .txt, .pdf или электронные книги (.epub, .fb2, .mobi, .azw3). Без источников ответы берутся из интернета.',
    open: 'Открыть {{name}}',
    deleteLabel: 'Удалить {{name}}',
    deleteTitle: 'Удалить источник',
    deleteConfirm:
      'Удалить <strong>{{name}}</strong> из <code>sources/</code>? Существующие ссылки на него перестанут работать.',
  },
  theme: {
    legend: 'Тема',
    auto: 'Авто',
    autoTitle: 'Авто (как в системе)',
    standard: 'Светлая',
    dark: 'Тёмная',
    cool: 'Холодная',
    coolTitle: 'Холодная светлая',
    hint: 'Наведите или ↑↓ — предпросмотр · Enter — выбрать',
  },
  language: {
    legend: 'Язык',
  },
} satisfies Messages<typeof en>;
