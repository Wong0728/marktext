// @vitest-environment happy-dom

import type Format from '../format';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Muya } from '../../../muya';

// The compositionend path is the engine's only chance to re-sync `this.text`
// with the DOM the IME has been driving. Cancelled compositions (Esc) and
// empty-data commits leave the DOM unchanged — the engine must absorb that
// without corrupting state (the desync class described in
// docs/ime-composition-delete-broken.md §3.4).

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

function firstBlock(muya: Muya): Format {
    const content = muya.editor.scrollPage!.firstContentInDescendant() as unknown as Format;
    muya.editor.activeContentBlock = content;
    return content;
}

function composeEvent(type: 'compositionstart' | 'compositionend'): Event {
    return new Event(type, { bubbles: true });
}

// `isComposed` is protected; the spec reads it through a cast (test files are
// exempt from muya's strict cast rule).
function isComposed(content: Format): boolean {
    return (content as unknown as { isComposed: boolean }).isComposed;
}

describe('paragraph composition lifecycle', () => {
    it('cancelled composition (compositionend with unchanged DOM) keeps text intact', () => {
        const muya = bootMuya('hello\n');
        const content = firstBlock(muya);
        content.setCursor(0, 5);

        content.composeHandler(composeEvent('compositionstart'));
        expect(isComposed(content)).toBe(true);

        // The IME cancelled: the DOM still holds the pre-composition text.
        content.composeHandler(composeEvent('compositionend'));

        expect(isComposed(content)).toBe(false);
        expect(content.text).toBe('hello');
    });

    it('committed composition syncs the IME text into engine state', () => {
        const muya = bootMuya('hello\n');
        const content = firstBlock(muya);
        content.setCursor(0, 5);

        content.composeHandler(composeEvent('compositionstart'));

        // The browser appended the committed composition string to the DOM.
        // Append a text node (rather than replacing textContent) so the
        // cached caret node survives, as it does in the real browser.
        content.domNode!.appendChild(document.createTextNode('你好'));

        content.composeHandler(composeEvent('compositionend'));

        expect(isComposed(content)).toBe(false);
        expect(content.text).toBe('hello你好');
    });
});
