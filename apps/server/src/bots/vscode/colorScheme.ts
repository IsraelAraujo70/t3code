/**
 * VS Code follows T3's light or dark mode, not the operating system's. A frame's
 * `prefers-color-scheme` always reports the system (Chromium ignores the embedder's
 * `color-scheme`), so the workbench page gets a script that answers VS Code's two
 * color-scheme queries from the URL parameter, then from the panel's messages.
 */

import { VSCODE_COLOR_SCHEME_MESSAGE, VSCODE_COLOR_SCHEME_PARAM } from "@t3tools/contracts";

const shim = `(() => {
  const nativeMatchMedia = window.matchMedia.bind(window);
  const initial = new URLSearchParams(location.search).get(${JSON.stringify(VSCODE_COLOR_SCHEME_PARAM)});
  let dark = initial === null ? nativeMatchMedia("(prefers-color-scheme: dark)").matches : initial === "dark";
  const lists = new Map(["dark", "light"].map((scheme) => {
    const media = "(prefers-color-scheme: " + scheme + ")";
    const listeners = new Set();
    const list = {
      media,
      onchange: null,
      get matches() { return dark === (scheme === "dark"); },
      addEventListener(type, listener) { if (type === "change" && listener) listeners.add(listener); },
      removeEventListener(type, listener) { listeners.delete(listener); },
      addListener(listener) { if (listener) listeners.add(listener); },
      removeListener(listener) { listeners.delete(listener); },
      dispatchEvent() { return true; },
      notify() {
        const event = { matches: list.matches, media };
        for (const listener of [...listeners]) {
          if (typeof listener === "function") listener.call(list, event);
          else listener.handleEvent(event);
        }
        if (typeof list.onchange === "function") list.onchange.call(list, event);
      },
    };
    return [media, list];
  }));
  window.matchMedia = (query) => lists.get(String(query).replace(/\\s+/g, " ").trim()) ?? nativeMatchMedia(query);
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.data?.type !== ${JSON.stringify(VSCODE_COLOR_SCHEME_MESSAGE)}) return;
    const next = event.data.scheme === "dark";
    if (next === dark) return;
    dark = next;
    for (const list of lists.values()) list.notify();
  });
})();`;

/**
 * The workbench page with the shim first in its head, under the page's own script nonce so its
 * Content-Security-Policy allows it. Any other page passes through unchanged.
 */
export const withColorSchemeShim = (html: string) => {
  if (!html.includes('id="vscode-workbench-web-configuration"')) return html;
  const nonce = /<script nonce="([^"]+)"/.exec(html)?.[1];
  const head = html.indexOf("<head>");
  if (nonce === undefined || head === -1) return html;
  const at = head + "<head>".length;
  return `${html.slice(0, at)}<script nonce="${nonce}">${shim}</script>${html.slice(at)}`;
};
