// @vitest-environment happy-dom

import type Content from '../../block/base/content';
import type { Muya } from '../../muya';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Muya as MuyaClass } from '../../muya';
import { SelectionCaretType, SelectionDirection } from '../../selection/types';

vi.mock('../../utils/prism/index', () => ({
    default: {},
    walkTokens: () => null,
    loadedLanguages: new Set(),
    transformAliasToOrigin: (s: string) => s,
    loadLanguage: () => null,
    search: () => [],
}));

// A cut must form its OWN undo entry. `cutSelection` never marked an input
// boundary, so a cut inside the 1s coalescing window merged with the
// surrounding typed text into one entry — one Ctrl+Z then reverted both the
// typed text and the cut. `markInputBoundary('deleteByCut')` breaks the
// insert→delete group exactly like the Backspace/Delete input types do.

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

function firstContent(muya: Muya): Content {
    return muya.editor.scrollPage!.firstContentInDescendant()!;
}

function stubSameBlockSelection(muya: Muya, block: Content, start: number, end: number) {
    const path = block.path;
    muya.editor.selection.getSelection = () => ({
        anchor: { offset: start, block, path },
        focus: { offset: end, block, path },
        isCollapsed: false,
        isSelectionInSameBlock: true,
        direction: SelectionDirection.FORWARD,
        type: SelectionCaretType.RANGE,
    });
}

function undoDepth(muya: Muya): number {
    // @ts-expect-error — reach into the private stack for test assertions.
    return muya.editor.history._stack.undo.length;
}

describe('cut — forms its own undo entry inside the coalescing window', () => {
    it('one undo after type+cut reverts only the cut', async () => {
        const muya = bootMuya('hello world\n');
        const content = firstContent(muya);

        // Type '!!' at the end of the block, marking the input boundary the
        // way `inputHandler` does for a real keystroke.
        content.setCursor(11, 11, true);
        content.text = 'hello world!!';
        muya.editor.history.markInputBoundary('insertText', '!');
        muya.editor.transactions.flush();
        await vi.waitFor(() => {
            expect(muya.getMarkdown()).toBe('hello world!!\n');
        });

        // Cut the just-typed '!!' back out, still within the coalescing window.
        stubSameBlockSelection(muya, content, 11, 13);
        muya.editor.clipboard.cutHandler();
        muya.editor.transactions.flush();
        expect(muya.getMarkdown()).toBe('hello world\n');

        // The cut must be its own entry…
        expect(undoDepth(muya)).toBe(2);
        // …so the first Ctrl+Z restores the typed text.
        muya.editor.history.undo();
        expect(muya.getMarkdown()).toBe('hello world!!\n');
    });
});
