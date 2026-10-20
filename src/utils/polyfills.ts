/**
 * Compatibility shims for libraries that assume a DOM/Node environment.
 *
 * JSZip (used by PptxGenJS) installs a `setImmediate` polyfill based on
 * `postMessage`, which never delivers messages inside the Zotero plugin
 * sandbox, so `generateAsync()` never settles. Defining `setImmediate` before
 * JSZip is loaded makes it use this implementation instead.
 *
 * This module must be imported before `pptxgenjs` / `jszip`.
 */

const globalObj = globalThis as any;

if (typeof globalObj.setImmediate !== "function") {
  globalObj.setImmediate = (
    callback: (...args: unknown[]) => void,
    ...args: unknown[]
  ): number => {
    return setTimeout(() => callback(...args), 0) as unknown as number;
  };
}

if (typeof globalObj.clearImmediate !== "function") {
  globalObj.clearImmediate = (handle: number): void => {
    clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
  };
}

export {};
