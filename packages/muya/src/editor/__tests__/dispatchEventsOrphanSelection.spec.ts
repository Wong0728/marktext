// @vitest-environment happy-dom

import type Content from '../../block/base/content';
import type { ISelection } from '../../selection/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Muya } from '../../muya';
import { SelectionCaretType, SelectionDirection } from '../../selection/types';
// Regression tests for the "can type but cannot delete" failure under IME
// composition (see docs/ime-composition-delete-broken.md). When the browser
// clones an orphan `span.mu-content` (e.g. an un-cancelled Enter during
// composition), `TextSelection.getSelection()` returns null because the orphan
// has no `__MUYA_BLOCK__` backlink. `Editor._dispatchEvents` used to react by
// clearing `activeContentBlock` and returning — permanently detaching the
// engine from all further events. The fix keeps the previous valid block and
// only skips the current event's block dispatch.

const bootedHosts: HTMLElement[] = [];
let hadVersion = false;
let originalVersion: string | undefined;

beforeEach(() => {
    hadVersion = 'MUYA_VERSION' in window;
    originalVersion = window.MUYA_VERSION;
    window.MUYA_VERSION = 'test';
});

afterEach(() => {
    vi.restoreAllMocks();
    while (bootedHosts.length) {
        const host = bootedHosts.pop()!;
        host.remove();
    }
    if (hadVersion)
        window.MUYA_VERSION = originalVersion as string;
    else
        delete (window as Partial<Window>).MUYA_VERSION;
});

function bootMuya(markdown: string): Muya {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const muya = new Muya(host, { markdown } as ConstructorParameters<typeof Muya>[1]);
    muya.init();
    bootedHosts.push(muya.domNode);
    return muya;
}

describe('editor._dispatchEvents with an unresolved (orphan) selection', () => {
    it('keeps activeContentBlock and skips block dispatch while getSelection() returns null', () => {
        const muya = bootMuya('alpha\n\nbeta\n');
        const first = muya.editor.scrollPage!.firstContentInDescendant() as Content;
        first.setCursor(0, 0, true);
        expect(muya.editor.activeContentBlock).toBe(first);

        vi.spyOn(muya.editor.selection, 'getSelection').mockReturnValue(null);
        const inputSpy = vi.spyOn(first, 'inputHandler');
        const keydownSpy = vi.spyOn(first, 'keydownHandler');

        muya.domNode.dispatchEvent(new InputEvent('input', { bubbles: true }));
        muya.domNode.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'x' }));
        muya.domNode.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Backspace' }));

        expect(muya.editor.activeContentBlock).toBe(first);
        expect(inputSpy).not.toHaveBeenCalled();
        expect(keydownSpy).not.toHaveBeenCalled();
    });

    it('recovers on the next event once the selection resolves again', () => {
        const muya = bootMuya('alpha\n\nbeta\n');
        const first = muya.editor.scrollPage!.firstContentInDescendant() as Content;
        const second = muya.editor.scrollPage!.lastContentInDescendant() as Content;
        first.setCursor(0, 0, true);
        expect(muya.editor.activeContentBlock).toBe(first);

        const getSelectionSpy = vi.spyOn(muya.editor.selection, 'getSelection').mockReturnValue(null);
        muya.domNode.dispatchEvent(new InputEvent('input', { bubbles: true }));
        expect(muya.editor.activeContentBlock).toBe(first);

        // Selection resolves again (e.g. user clicks back into real content).
        getSelectionSpy.mockRestore();
        second.setCursor(0, 0, true);
        const inputSpy = vi.spyOn(second, 'inputHandler');
        muya.domNode.dispatchEvent(new InputEvent('input', { bubbles: true }));

        expect(muya.editor.activeContentBlock).toBe(second);
        expect(inputSpy).toHaveBeenCalledTimes(1);
    });

    it('dispatches to the anchor block reported by a mocked selection result', () => {
        const muya = bootMuya('alpha\n\nbeta\n');
        const first = muya.editor.scrollPage!.firstContentInDescendant() as Content;
        const second = muya.editor.scrollPage!.lastContentInDescendant() as Content;
        first.setCursor(0, 0, true);
        expect(muya.editor.activeContentBlock).toBe(first);

        const fakeSelection = {
            anchor: { offset: 0, block: second, path: second.path },
            focus: { offset: 0, block: second, path: second.path },
            isCollapsed: true,
            isSelectionInSameBlock: true,
            direction: SelectionDirection.FORWARD,
            type: SelectionCaretType.CARET,
        } as ISelection;
        vi.spyOn(muya.editor.selection, 'getSelection').mockReturnValue(fakeSelection);
        const keydownSpy = vi.spyOn(second, 'keydownHandler');

        muya.domNode.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'x' }));

        expect(muya.editor.activeContentBlock).toBe(second);
        expect(keydownSpy).toHaveBeenCalledTimes(1);
    });
});
