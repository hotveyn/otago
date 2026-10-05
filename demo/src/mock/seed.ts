/**
 * Seed trees: `demo/seed/` holds real tree folders (tree.md, node.md, sources/, attachments/),
 * bundled as text at build time and written to the VFS on first visit and on reset.
 */
const files = import.meta.glob<string>('../../seed/**/*', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const PREFIX = '../../seed/';

/** VFS path → text. */
export function seedFiles(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files).map(([path, text]) => [path.slice(PREFIX.length), text]),
  );
}
