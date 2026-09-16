/**
 * Globals that exist inside the recorded page, not in Node.
 *
 * `stage` is defined by demo/stage.html and `act` by public/index.html. Playwright
 * serialises the callbacks in record-video.ts and runs them in the browser, so these are
 * genuinely in scope there — declaring them keeps that boundary explicit instead of
 * silencing the compiler.
 */
declare const stage: {
  bar(step: string, title: string, note?: string): void;
  card(h1: string, p?: string, kbd?: string): void;
  hideCard(): void;
  pane(which: string | null): void;
  callout(html: string | null): void;
  clearTerm(): void;
  type(lines: string[], opts?: { perLine?: number; highlight?: string[] }): Promise<void>;
  loadRooms(url: string): void;
};

declare function act(taskId: string, action: string, version: number, note?: string): Promise<void>;
