import { type QueryClient, useQuery } from '@tanstack/react-query';
import { api } from './client';
import type { FileFolder, SourceInfo, TreeDetail, TreeMeta } from './types';

export const keys = {
  trees: ['trees'] as const,
  tree: (id: string) => ['tree', id] as const,
  chain: (tree: string, node: string) => ['chain', tree, node] as const,
  sources: (tree: string) => ['sources', tree] as const,
  source: (tree: string, file: string) => ['source', tree, file] as const,
  models: ['models'] as const,
  /**
   * `size` is part of the key so a regenerated file with the same name is refetched.
   * `folder` keeps a user file and an agent attachment with the same name apart.
   */
  attachment: (
    tree: string,
    node: string,
    name: string,
    size: number,
    folder: FileFolder = 'attachments',
  ) => ['attachment', tree, node, folder, name, size] as const,
  attachmentBlob: (
    tree: string,
    node: string,
    name: string,
    size: number,
    folder: FileFolder = 'attachments',
  ) => ['attachment-blob', tree, node, folder, name, size] as const,
};

/**
 * Tree rename, first half (before the URL switches): seed the caches of the new tree id from
 * the old one, so nothing refetches or flashes while the view moves over. Node ids and sources
 * are tree-relative, so they carry over unchanged. The caller still invalidates `keys.trees`.
 */
export function moveTreeCaches(queryClient: QueryClient, from: string, updated: TreeMeta): void {
  const meta: TreeMeta = {
    id: updated.id,
    title: updated.title,
    created: updated.created,
    instructions: updated.instructions,
  };
  const detail = queryClient.getQueryData<TreeDetail>(keys.tree(from));
  if (detail) queryClient.setQueryData<TreeDetail>(keys.tree(meta.id), { ...detail, ...meta });
  const sources = queryClient.getQueryData<SourceInfo[]>(keys.sources(from));
  if (sources) queryClient.setQueryData<SourceInfo[]>(keys.sources(meta.id), sources);
  queryClient.setQueryData<TreeMeta[]>(keys.trees, (list) =>
    list?.map((item) => (item.id === from ? meta : item)),
  );
}

/** Tree rename, second half (after the navigation rendered): forget every cache of the old id. */
export function dropTreeCaches(queryClient: QueryClient, treeId: string): void {
  for (const kind of ['tree', 'chain', 'sources', 'source', 'attachment', 'attachment-blob'])
    queryClient.removeQueries({ queryKey: [kind, treeId] });
}

export const useTrees = () => useQuery({ queryKey: keys.trees, queryFn: api.listTrees });

export const useTree = (id: string | null) =>
  useQuery({
    queryKey: keys.tree(id ?? ''),
    queryFn: () => api.getTree(id ?? ''),
    enabled: id !== null,
  });

export const useChain = (tree: string | null, node: string) =>
  useQuery({
    queryKey: keys.chain(tree ?? '', node),
    queryFn: () => (node === '' ? Promise.resolve([]) : api.getChain(tree ?? '', node)),
    enabled: tree !== null,
    placeholderData: (previous) => previous,
  });

export const useSources = (tree: string | null) =>
  useQuery({
    queryKey: keys.sources(tree ?? ''),
    queryFn: () => api.listSources(tree ?? ''),
    enabled: tree !== null,
  });

export const useSourceText = (tree: string, file: string, enabled: boolean) =>
  useQuery({
    queryKey: keys.source(tree, file),
    queryFn: () => api.getSourceText(tree, file),
    enabled,
  });

export const useModels = () =>
  useQuery({ queryKey: keys.models, queryFn: api.getModels, staleTime: Number.POSITIVE_INFINITY });

export const useAttachmentText = (
  tree: string,
  node: string,
  name: string,
  size: number,
  enabled: boolean,
  folder: FileFolder = 'attachments',
) =>
  useQuery({
    queryKey: keys.attachment(tree, node, name, size, folder),
    queryFn: () => api.getAttachmentText(tree, node, name, folder),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
  });

/** Binary attachment (PDF preview). Not kept in the cache once unused. */
export const useAttachmentBlob = (
  tree: string,
  node: string,
  name: string,
  size: number,
  folder: FileFolder = 'attachments',
) =>
  useQuery({
    queryKey: keys.attachmentBlob(tree, node, name, size, folder),
    queryFn: () => api.getAttachmentBlob(tree, node, name, folder),
    gcTime: 0,
  });
