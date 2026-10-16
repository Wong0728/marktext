// @vitest-environment happy-dom

import type Content from '../../block/base/content';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BLOCK_DOM_PROPERTY } from '../../config';
import { Muya } from '../../muya';

// `TextSelection.getSelection()` orphan self-heal. The browser can clone an
// `mu-content` span during native edit behavior (e.g. an un-cancelled Enter
// while an IME composition is active, see
// docs/ime-composition-delete-broken.md). The clone lacks the
// `BLOCK_DOM_PROPERTY` backlink, so an offset measured inside it is relative
// to the clone — committing it parked the caret at a wrong (often zero)
// position of the real block. getSelection() now drops the clone, re-renders
// the real block from state, and re-reads a clean selection. During an active
// IME composition the DOM is left untouched and the clone is tolerated.

const bootedHosts: HTMLElement[] = [];
let originalVersion: string | undefined;
let hadVersion = false;

beforeEach(() => {
    hadVersion = 'MUYA_VERSION' in window;
    originalVersion = window.MUYA_VERSION;
    window.MUYA_VERSION = 'test';
});

afterEach(() => {
    while (bootedHosts.length) {
        const host = bootedHosts.pop()!;
        host.remove();
    }
    document.getSelection()?.removeAllRanges();
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

describe('textSelection.getSelection() orphan self-heal', () => {
    it('drops the cloned span, re-renders the real block, and resolves a clean selection', () => {
        const muya = bootMuya('alpha\n\nbeta\n');
        const first = muya.editor.scrollPage!.firstContentInDescendant() as Content;
        first.setCursor(0, 0, true);

        // Simulate the browser cloning the content span: cloneNode copies
        // classes and children but not the expando BLOCK_DOM_PROPERTY.
        const realDom = first.domNode!;
        const orphan = realDom.cloneNode(true) as HTMLElement;
        expect(orphan[BLOCK_DOM_PROPERTY]).toBeUndefined();
        realDom.parentElement!.insertBefore(orphan, realDom.nextSibling);

        const selection = document.getSelection()!;
        const range = document.createRange();
        range.selectNodeContents(orphan);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);

        const result = muya.editor.selection.getSelection();

        expect(result).not.toBeNull();
        expect(result!.anchor.block).toBe(first);
        expect(result!.focus.block).toBe(first);
        expect(result!.isSelectionInSameBlock).toBe(true);
        // The clone was removed and the caret parked at a known good
        // position inside the real block.
        expect(orphan.isConnected).toBe(false);
        expect(realDom.parentElement!.querySelectorAll('.mu-content').length).toBe(1);
        expect(result!.anchor.offset).toBe(0);
        expect(result!.focus.offset).toBe(0);
        // State stayed untouched by the clone.
        expect(first.text).toBe('alpha');
    });

    it('tolerates the clone while an IME composition owns the real block DOM', () => {
        const muya = bootMuya('alpha\n\nbeta\n');
        const first = muya.editor.scrollPage!.firstContentInDescendant() as Content;
        first.setCursor(0, 0, true);

        const realDom = first.domNode!;
        const orphan = realDom.cloneNode(true) as HTMLElement;
        realDom.parentElement!.insertBefore(orphan, realDom.nextSibling);

        const selection = document.getSelection()!;
        const range = document.createRange();
        range.selectNodeContents(orphan);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);

        first.isComposed = true;
        try {
            const result = muya.editor.selection.getSelection();

            expect(result).not.toBeNull();
            expect(result!.anchor.block).toBe(first);
            // The DOM is the browser's during composition: no healing.
            expect(orphan.isConnected).toBe(true);
        }
        finally {
            first.isComposed = false;
        }

        // The first event after compositionend heals.
        const healed = muya.editor.selection.getSelection();
        expect(orphan.isConnected).toBe(false);
        expect(healed!.anchor.offset).toBe(0);
    });

    it('still returns null when the caret is outside any content-like node', () => {
        const muya = bootMuya('alpha\n\nbeta\n');
        const selection = document.getSelection()!;
        const range = document.createRange();
        range.selectNodeContents(muya.domNode);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);

        expect(muya.editor.selection.getSelection()).toBeNull();
    });
});
