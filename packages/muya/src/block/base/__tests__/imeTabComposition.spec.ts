// @vitest-environment happy-dom

import type Format from '../format';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Muya } from '../../../muya';

// #1250 — while an IME composition is active (e.g. cycling Japanese
// candidates), structural keys must not run the editor handlers: the native
// behavior would split the contenteditable DOM and orphan nodes without
// `__MUYA_BLOCK__` back references. keydownHandler therefore preventDefaults
// Enter / arrows / Tab / Backspace / Delete during composition instead of
// delegating to enterHandler / arrowHandler / tabHandler / backspaceHandler /
// deleteHandler.

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
    muya.editor.activeContentBlock = content as never;
    return content;
}

function pressKey(content: Format, key: string): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    content.keydownHandler(event);
    return event;
}

describe('keydown during IME composition (#1250)', () => {
    const cases = [
        { key: 'Enter', handler: 'enterHandler' },
        { key: 'Tab', handler: 'tabHandler' },
        { key: 'ArrowUp', handler: 'arrowHandler' },
        { key: 'ArrowDown', handler: 'arrowHandler' },
        { key: 'ArrowLeft', handler: 'arrowHandler' },
        { key: 'ArrowRight', handler: 'arrowHandler' },
        { key: 'Backspace', handler: 'backspaceHandler' },
        { key: 'Delete', handler: 'deleteHandler' },
    ] as const;

    it.each(cases)('preventDefaults $key and skips $handler while composing', ({ key, handler }) => {
        const muya = bootMuya('hello\n');
        const content = firstBlock(muya);
        content.setCursor(0, 5);
        content.composeHandler(new Event('compositionstart'));
        const spy = vi.spyOn(content, handler);

        const event = pressKey(content, key);

        expect(spy).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(true);
        expect(content.text).toBe('hello');
    });

    it.each(cases)('runs $handler normally when not composing', ({ key, handler }) => {
        const muya = bootMuya('hello\n');
        const content = firstBlock(muya);
        content.setCursor(0, 5);
        const spy = vi.spyOn(content, handler);

        pressKey(content, key);

        expect(spy).toHaveBeenCalled();
    });
});
