type AddCaptionCallbackSet = {
  onSubmit: (scanId: string, caption: string, isLast: boolean) => void | Promise<void>;
  onSkip: () => void | Promise<void>;
  onAddToFolder: () => void | Promise<void>;
  onDelete?: (scanId: string) => void | Promise<void>;
};

const callbackRegistry = new Map<string, AddCaptionCallbackSet>();

function makeCallbackId(): string {
  return `caption_cb_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function registerAddCaptionCallbacks(callbacks: AddCaptionCallbackSet): string {
  const callbackId = makeCallbackId();
  callbackRegistry.set(callbackId, callbacks);
  return callbackId;
}

export function getAddCaptionCallbacks(callbackId?: string | null): AddCaptionCallbackSet | null {
  if (!callbackId) return null;
  return callbackRegistry.get(callbackId) ?? null;
}

export function clearAddCaptionCallbacks(callbackId?: string | null): void {
  if (!callbackId) return;
  callbackRegistry.delete(callbackId);
}

