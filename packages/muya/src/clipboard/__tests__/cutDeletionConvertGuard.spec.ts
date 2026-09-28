// @vitest-environment happy-dom

import type Content from '../../block/base/content';
import type { Muya } from '../../muya';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Muya as MuyaClass } from '../../muya';
import { SelectionCaretType, SelectionDirection } from '../../selection/types';

// Deletion-mode conversion guard: `setCursorAndConvert` re-evaluates the start
// block's type after a cut, but a marker merely EXPOSED on a soft line
// (`foo\n#tag` losing `tag`) must not split or re-type the block. Block-leading
// markers keep converting (cutBlockConvert.spec.ts pins that muyajs parity).

vi.mock('../../utils/prism/index', () => ({
    default: {},
    walkTokens: () => null,
    loadedLanguages: new Set(),
    transformAliasToOrigin: (s: string) => s,
    loadLanguage: () => null,
    search: () => [],
}));

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
    // Capture `path` eagerly: the cut may trigger a block-type conversion that
    // detaches `block`, and a re-entrant `getSelection` would otherwise read a
    // null parent off the stale node.
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

async function cut(muya: Muya): Promise<void> {
    muya.editor.clipboard.cutHandler();
    await new Promise(r => setTimeout(r, 40));
}

describe('cut — deletion-exposed soft-line markers do not convert', () => {
    it('cutting "tag" from `foo\\n#tag` leaves the paragraph intact', async () => {
        const muya = bootMuya('foo\n#tag\n');
        const block = firstContent(muya);
        stubSameBlockSelection(muya, block, 5, 8); // select "tag"
        await cut(muya);

        expect(muya.editor.scrollPage!.firstChild!.blockName).toBe('paragraph');
        expect(muya.getMarkdown()).toBe('foo\n#\n');
    });

    it('cutting into `1. million` still promotes to an order list (block-leading parity)', async () => {
        const muya = bootMuya('1.5 million\n');
        const block = firstContent(muya);
        const realGetSelection
            = muya.editor.selection.getSelection.bind(muya.editor.selection);
        stubSameBlockSelection(muya, block, 2, 3); // select "5"
        await cut(muya);

        // Restore the real DOM-backed selection reader: the stub above would
        // otherwise keep reporting the pre-cut range off the detached block.
        muya.editor.selection.getSelection = realGetSelection;

        expect(muya.editor.scrollPage!.firstChild!.blockName).toBe('order-list');
        expect(muya.getMarkdown()).toBe('1. million\n');

        // The caret seats in the list item's content, clamped to its start —
        // the deletion point sat inside the consumed `1. ` marker.
        const selection = muya.editor.selection.getSelection();
        expect(selection?.anchor.offset).toBe(0);
        expect(selection?.anchor.block.text).toBe('million');
    });
});
