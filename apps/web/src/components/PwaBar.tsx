import { useSyncExternalStore } from "react";

import { applyUpdate, pwa } from "../pwa.js";

/**
 * The three things the service worker has to say out loud.
 *
 * Above the content at every width, like the ringing banner, because all three
 * change what the screen underneath is worth: offline it is not current, and
 * out of date it is not this build.
 */
export function PwaBar() {
  const state = useSyncExternalStore(pwa.subscribe, pwa.getState, pwa.getState);

  if (!state.online) {
    return (
      <div className="pwa-bar pwa-bar--offline" role="status" data-testid="offline-bar">
        <span>
          オフラインです。表示中の内容は最新ではない可能性があり、確認や送信はできません。
        </span>
      </div>
    );
  }

  if (state.updateReady) {
    return (
      <div className="pwa-bar pwa-bar--update" role="status" data-testid="update-bar">
        <span>新しいバージョンがあります。</span>
        <button
          type="button"
          className="button button--quiet"
          onClick={applyUpdate}
          data-testid="apply-update"
        >
          再読み込み
        </button>
      </div>
    );
  }

  if (state.canInstall) {
    return (
      <div className="pwa-bar pwa-bar--install" role="status" data-testid="install-bar">
        <span>アプリとして追加すると、ホーム画面から開けます。</span>
        <button
          type="button"
          className="button button--quiet"
          onClick={() => void pwa.install()}
          data-testid="install-app"
        >
          追加
        </button>
      </div>
    );
  }

  return null;
}
