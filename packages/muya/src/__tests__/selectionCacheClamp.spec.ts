// @vitest-environment happy-dom

import type Format from '../block/base/format';
import type { Muya } from '../muya';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Muya as MuyaClass } from '../muya';

vi.mock('../utils/prism/index', () => ({
    default: {},
    walkTokens: () => null,
    loadedLanguages: new Set(),
    transformAliasToOrigin: (s: string) => s,
    loadLanguage: () => null,
    search: () => [],
}));

// Cached caret offsets must stay inside the block's text. An offset past the
// text used to park the DOM caret at the block end (via `getLegalOffset`)
// while `TextSelection.anchor`/`focus` kept the overshoot — the cache and the
// visible caret diverged and the next edit spliced at a phantom position.
// `_updateSelection` now clamps the cached offsets at the single bottleneck
// every `setSelection` flows through.

const bootedHosts: HTMLElement[] = [];
let hadVersion = false;
let originalVersion: string | undefined;

beforeEach(() => {
    hadVersion = 'MUYA_VERSION' in window;
    originalVersion = window.MUYA_VERSION;
    window.MUYA_VERSION = 'test';
});

afterEach(() => {
    while (bootedHosts.length)
        bootedHosts.pop()!.remove();
    document.getSelection()?.removeAllRanges();
    if (hadVersion)
        window.MUYA_VERSION = originalVersion as string;
    else
        delete (window as Partial<Window>).MUYA_VERSION;
});

function bootMuya(markdown: string): Muya {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const muya = new MuyaClass(host, { markdown } as ConstructorParameters<typeof MuyaClass>[1]);
    muya.init();
    bootedHosts.push(muya.domNode);
    return muya;
}

describe('textSelection — cached offsets are clamped to the block text', () => {
    it('clamps a caret set past the end of the block text', () => {
        const muya = bootMuya('seed\n');
        const content = muya.editor.scrollPage!.firstContentInDescendant() as unknown as Format;

        content.setCursor(10, 10); // 'seed'.length === 4

        expect(muya.editor.selection.anchor?.offset).toBe(4);
        expect(muya.editor.selection.focus?.offset).toBe(4);
        // The DOM-derived read agrees with the cache — no divergence.
        expect(content.getCursor()?.start.offset).toBe(4);
        expect(content.getCursor()?.end.offset).toBe(4);
    });

    it('clamps a range whose focus overshoots the block text', () => {
        const muya = bootMuya('seed\n');
        const content = muya.editor.scrollPage!.firstContentInDescendant() as unknown as Format;

        content.setCursor(1, 10);

        expect(muya.editor.selection.anchor?.offset).toBe(1);
        expect(muya.editor.selection.focus?.offset).toBe(4);
    });

    it('leaves in-range offsets untouched', () => {
        const muya = bootMuya('seed\n');
        const content = muya.editor.scrollPage!.firstContentInDescendant() as unknown as Format;

        content.setCursor(1, 3);

        expect(muya.editor.selection.anchor?.offset).toBe(1);
        expect(muya.editor.selection.focus?.offset).toBe(3);
    });
});
