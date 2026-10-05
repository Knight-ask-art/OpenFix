import { type Ref } from "react";

// Electron keeps this webview's session between app launches. Give the SPA
// document a fresh URL each launch so Chromium cannot keep an old index.html
// after an application update; content-hashed assets can still be cached.
const FRONTEND_DOCUMENT_CACHE_KEY = Date.now().toString(36);

export interface FrontendWebviewElement extends HTMLElement {
  canGoBack: () => boolean;
  goBack: () => void;
  canGoForward: () => boolean;
  goForward: () => void;
  send: (channel: string, ...args: unknown[]) => void;
}

interface FrontendPageProps {
  webviewKey: number;
  partition: string;
  webviewRef: Ref<FrontendWebviewElement>;
}

export function FrontendPage({ webviewKey, partition, webviewRef }: FrontendPageProps) {
  return (
    <section className="content-page content-page-fill">
      <webview
        key={webviewKey}
        ref={webviewRef}
        className="frontend-webview"
        src={`app://openfic/?_=${FRONTEND_DOCUMENT_CACHE_KEY}`}
        partition={partition}
        preload={window.openficDesktop.frontendHostPreloadPath}
      />
    </section>
  );
}
