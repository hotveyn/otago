export const graph = {
  ghostTitle: 'Next answer appears here',
  rootTitle: 'Tree root',
  selected: '{{count}} selected',
  inside: '({{count}} inside)',
  moveTo: 'Move to…',
  clear: 'Clear',
  rename: 'Rename',
  hint: 'Click to open · Shift/⌘-click to select · drag onto a node to move · Ctrl/⌘+Z to undo',
  busy: 'Answering… changes are paused',
  delete: {
    title_one: 'Delete node',
    title_other: 'Delete {{count}} nodes',
    confirm: 'Delete {{count}}',
    deleting: 'Deleting…',
    body_one: 'This removes <strong>{{count}}</strong> node. You can bring it back with Ctrl/⌘+Z.',
    body_other:
      'This removes <strong>{{count}}</strong> nodes. You can bring them back with Ctrl/⌘+Z.',
    bodyNested_one:
      'This removes <strong>{{count}}</strong> node ({{selected}} selected + {{descendants}}). You can bring it back with Ctrl/⌘+Z.',
    bodyNested_other:
      'This removes <strong>{{count}}</strong> nodes ({{selected}} selected + {{descendants}}). You can bring them back with Ctrl/⌘+Z.',
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
  renameDialog: {
    title: 'Rename node',
    label: 'Name',
    confirm: 'Rename',
    saving: 'Renaming…',
    hint: 'The name becomes the folder name (lowercase, dashes). If a sibling already has it, "-2" is added. Ids of this node and its descendants change.',
  },
  undo: {
    stale: "Can't undo: the tree changed since then.",
    nodeMissing: "Can't undo: the node no longer exists.",
    parentMissing: "Can't undo: the original parent no longer exists.",
    trashMissing: "Can't undo: the deleted node is gone from the trash.",
    treeMissing: "Can't undo: the tree no longer exists.",
    invalid: "Can't undo this change.",
    failed: 'Undo failed: {{message}}',
  },
};
