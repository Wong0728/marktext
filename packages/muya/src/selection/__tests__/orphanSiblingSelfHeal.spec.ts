// @vitest-environment happy-dom

import type Content from '../../block/base/content';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BLOCK_DOM_PROPERTY } from '../../config';
import { Muya } from '../../muya';

// Fix C — `TextSelection.getSelection()` self-heal. The browser can clone an
// `mu-content` span during native edit behavior (e.g. an un-cancelled Enter
// while an IME composition is active, see
// docs/ime-composition-delete-broken.md). The clone lacks the
// `BLOCK_DOM_PROPERTY` backlink, which used to make getSelection() return
// null for the whole selection. It now adopts the adjacent real content node.

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
    it('resolves the selection through the real sibling block when the caret sits in a cloned span', () => {
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
