type SelectCollectionCallback = (folderId: string | null) => void;

const registry = new Map<string, SelectCollectionCallback>();

function makeCallbackId(): string {
  return `select_collection_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function registerSelectCollectionCallback(callback: SelectCollectionCallback): string {
  const id = makeCallbackId();
  registry.set(id, callback);
  return id;
}

export function invokeSelectCollectionCallback(id: string | null | undefined, folderId: string | null): void {
  if (!id) return;
  registry.get(id)?.(folderId);
}

export function clearSelectCollectionCallback(id: string | null | undefined): void {
  if (!id) return;
  registry.delete(id);
}
