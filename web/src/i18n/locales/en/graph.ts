export const graph = {
  ghostTitle: 'Next answer appears here',
  rootTitle: 'Tree root',
  selected: '{{count}} selected',
  inside: '({{count}} inside)',
  moveTo: 'Move to…',
  clear: 'Clear',
  hint: 'Click to open · Shift/⌘-click to select · drag onto a node to move',
  busy: 'Answering… changes are paused',
  delete: {
    title_one: 'Delete node',
    title_other: 'Delete {{count}} nodes',
    confirm: 'Delete {{count}}',
    deleting: 'Deleting…',
    body_one: 'This permanently removes <strong>{{count}}</strong> node. Git is the only backup.',
    body_other:
      'This permanently removes <strong>{{count}}</strong> nodes. Git is the only backup.',
    bodyNested_one:
      'This permanently removes <strong>{{count}}</strong> node ({{selected}} selected + {{descendants}}). Git is the only backup.',
    bodyNested_other:
      'This permanently removes <strong>{{count}}</strong> nodes ({{selected}} selected + {{descendants}}). Git is the only backup.',
    descendants_one: '{{count}} descendant',
    descendants_other: '{{count}} descendants',
  },
  move: {
    title_one: 'Move node',
    title_other: 'Move {{count}} nodes',
    confirm: 'Move here',
    moving: 'Moving…',
    hint: 'Choose the new parent. Descendants move along.',
  },
};
