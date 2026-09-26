import { useQuery } from '@tanstack/react-query';
import { api } from './client';
import type { FileFolder } from './types';

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
