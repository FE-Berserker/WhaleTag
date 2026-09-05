import type {
  ExtensionMessage,
  HostMessage,
} from '../../../shared/extension-types';
import { ipcApi } from '-/services/ipc-api';

/**
 * The `request* → reply` RPC cases of the extension message switch
 * (docs/07 §9 — extracted from ExtensionHost's god-switch). Every case is
 * the same three steps: one ipcApi call, a success reply, or an error
 * reply. `forwardRpc` owns that plumbing; each case only supplies its reply
 * constructors (reply types carry their own empty fields alongside `error`).
 */

type Post = (message: HostMessage) => void;

function forwardRpc<T>(
  post: Post,
  call: () => Promise<T>,
  onOk: (data: T) => HostMessage,
  onErr: (error: string) => HostMessage
): void {
  call()
    .then((data) => post(onOk(data)))
    .catch((e: unknown) =>
      post(onErr(e instanceof Error ? e.message : String(e)))
    );
}

/**
 * Build the RPC-case dispatcher. Returns a handler: `true` when the message
 * was an RPC case and has been dispatched (the reply posts asynchronously),
 * `false` so the caller falls through to its component-level switch.
 */
export function createRpcHandler(post: Post) {
  return (msg: ExtensionMessage): boolean => {
    switch (msg.type) {
      case 'requestHeicWasm':
        forwardRpc(
          post,
          () => ipcApi.getHeicWasm(),
          (data) => ({ type: 'heicWasm', requestId: msg.requestId, data }),
          (error) => ({
            type: 'heicWasm',
            requestId: msg.requestId,
            data: null,
            error,
          })
        );
        return true;

      default:
        return false;
    }
  };
}
