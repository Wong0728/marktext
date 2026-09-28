// @vitest-environment happy-dom

import type Content from '../../block/base/content';
import type { Muya } from '../../muya';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Muya as MuyaClass } from '../../muya';
import { SelectionCaretType, SelectionDirection } from '../../selection/types';

// The container-level keydown handler in clipboard/index.ts must bail out —
// without preventDefault() — when `selection.getSelection()` returns null.
// Previously the nullish destructure made `isSelectionInSameBlock` falsy, so
// Backspace/Delete/Enter were treated as a cross-block cut: the key was
// swallowed by preventDefault() and cutHandler() no-opped on the same null
// selection, leaving the user with zero feedback.

// The clipboard module pulls in CodeBlockContent → utils/prism which touches
// `window` at import time. Stub the prism shim (same stub as sibling specs).
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

function contentBlocks(muya: Muya): Content[] {
    const out: Content[] = [];
    let c: Content | null = muya.editor.scrollPage!.firstContentInDescendant();
    while (c) {
        out.push(c);
        c = c.nextContentInContext() ?? null;
    }
    return out;
}

function pressKey(key: string): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    return event;
}

describe('clipboard keydown — null selection (#null-selection guard)', () => {
    it.each(['Backspace', 'Delete', 'Enter'])(
        'does NOT swallow %s when getSelection() returns null',
        (key) => {
            const muya = bootMuya('hello\n');
            // ownsEvent() needs the editor to hold focus; stub it so the
            // handler proceeds to the selection read under test.
            vi.spyOn(muya, 'hasFocus').mockReturnValue(true);
            vi.spyOn(muya.editor.selection, 'getSelection').mockReturnValue(null);
            const cutHandler = vi.spyOn(muya.editor.clipboard, 'cutHandler');

            const event = pressKey(key);

            expect(event.defaultPrevented).toBe(false);
            expect(cutHandler).not.toHaveBeenCalled();
        },
    );
});

describe('clipboard keydown — selection shapes (smoke)', () => {
    it('same-block selection leaves Backspace alone (no cut, no preventDefault)', () => {
        const muya = bootMuya('hello\n');
        vi.spyOn(muya, 'hasFocus').mockReturnValue(true);
        const block = contentBlocks(muya)[0];
        const path = block.path;
        muya.editor.selection.getSelection = () => ({
            anchor: { offset: 1, block, path },
            focus: { offset: 3, block, path },
            isCollapsed: false,
            isSelectionInSameBlock: true,
            direction: SelectionDirection.FORWARD,
            type: SelectionCaretType.RANGE,
        });
        const cutHandler = vi.spyOn(muya.editor.clipboard, 'cutHandler');

        const event = pressKey('Backspace');

        expect(event.defaultPrevented).toBe(false);
        expect(cutHandler).not.toHaveBeenCalled();
    });

    it('cross-block selection still cuts on Backspace (preventDefault + cutHandler)', async () => {
        const muya = bootMuya('alpha\n\nbeta\n');
        vi.spyOn(muya, 'hasFocus').mockReturnValue(true);
        const blocks = contentBlocks(muya);
        // Capture paths eagerly: after the cut mutates the tree the start
        // block's parent is gone and its `path` getter would throw.
        const anchorPath = blocks[0].path;
        const focusPath = blocks[1].path;
        muya.editor.selection.getSelection = () => ({
            anchor: { offset: 1, block: blocks[0], path: anchorPath },
            focus: { offset: 2, block: blocks[1], path: focusPath },
            isCollapsed: false,
            isSelectionInSameBlock: false,
            direction: SelectionDirection.FORWARD,
            type: SelectionCaretType.RANGE,
        });
        const cutHandler = vi.spyOn(muya.editor.clipboard, 'cutHandler');

        const event = pressKey('Backspace');

        expect(event.defaultPrevented).toBe(true);
        expect(cutHandler).toHaveBeenCalledTimes(1);
        await new Promise(r => setTimeout(r, 40));
        expect(muya.getMarkdown()).toBe('ata\n');
    });
});
