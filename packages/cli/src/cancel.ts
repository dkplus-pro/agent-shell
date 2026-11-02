/**
 * Process-wide SIGINT bus. Node only suppresses the default "kill me" behaviour
 * while a listener exists, so the handler has to be installed before any async
 * startup work (config load, plugin import, MCP handshake) — otherwise Ctrl+C
 * during startup kills the process with a signal instead of exiting 130.
 */
type CancelListener = () => void;

const listeners = new Set<CancelListener>();
let installed = false;
let requested = false;

export function installSigintBus(): void {
  if (installed) return;
  installed = true;
  process.on('SIGINT', () => {
    requested = true;
    for (const listener of [...listeners]) listener();
  });
}

export function onCancel(listener: CancelListener): () => void {
  installSigintBus();
  listeners.add(listener);
  if (requested) listener();
  return () => {
    listeners.delete(listener);
  };
}

export function cancelRequested(): boolean {
  return requested;
}
