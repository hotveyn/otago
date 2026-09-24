import { useQuery } from '@tanstack/react-query';
import { api } from './client';

export const keys = {
  trees: ['trees'] as const,
  tree: (id: string) => ['tree', id] as const,
  chain: (tree: string, node: string) => ['chain', tree, node] as const,
  sources: (tree: string) => ['sources', tree] as const,
  source: (tree: string, file: string) => ['source', tree, file] as const,
  models: ['models'] as const,
  /** `size` is part of the key so a regenerated file with the same name is refetched. */
  attachment: (tree: string, node: string, name: string, size: number) =>
    ['attachment', tree, node, name, size] as const,
  attachmentBlob: (tree: string, node: string, name: string, size: number) =>
    ['attachment-blob', tree, node, name, size] as const,
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
) =>
  useQuery({
    queryKey: keys.attachment(tree, node, name, size),
    queryFn: () => api.getAttachmentText(tree, node, name),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
  });

/** Binary attachment (PDF preview). Not kept in the cache once unused. */
export const useAttachmentBlob = (tree: string, node: string, name: string, size: number) =>
  useQuery({
    queryKey: keys.attachmentBlob(tree, node, name, size),
    queryFn: () => api.getAttachmentBlob(tree, node, name),
    gcTime: 0,
  });
