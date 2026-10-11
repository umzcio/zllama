const SERVERS_CHANGED_EVENT = "zllama:servers-changed";

export function notifyServersChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(SERVERS_CHANGED_EVENT));
}

export function subscribeServersChanged(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(SERVERS_CHANGED_EVENT, callback);
  return () => window.removeEventListener(SERVERS_CHANGED_EVENT, callback);
}
