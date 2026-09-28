// @vitest-environment happy-dom

import type Content from '../../../base/content';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Muya } from '../../../../muya';

// #1250 — codeBlockContent has no composition coverage of its own. Its
// inputHandler early-exits while `isComposed` (the browser still owns the
// DOM text), and the base keydownHandler gates Enter / Backspace / Delete /
// Tab / arrows during composition so the engine never mutates `this.text`
// while the composition string hangs off the DOM. We boot a real Muya and
// drive the block the way Editor._dispatchEvents does.

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

// Resolve the single `codeblock.content` leaf, the way a click on the code
// block resolves the active content block.
function codeContent(muya: Muya): Content {
    let target: Content | null = null;
    const visit = (block: {
        constructor: { blockName?: string };
        children?: { forEach: (cb: (b: unknown) => void) => void };
    }) => {
        if (block.constructor.blockName === 'codeblock.content')
            target = block as unknown as Content;
        block.children?.forEach(b => visit(b as typeof block));
    };
    visit(muya.editor.scrollPage as unknown as Parameters<typeof visit>[0]);
    if (!target)
        throw new Error('codeblock.content block not found');
    return target;
}

function pressKey(content: Content, key: string): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    content.keydownHandler(event);
    return event;
}

describe('codeBlockContent composition gating (#1250)', () => {
    it('inputHandler early-exits while composing — autoPair is never reached', () => {
        const muya = bootMuya('```js\nconst a = 1\n```\n');
        const content = codeContent(muya);
        muya.editor.activeContentBlock = content;
        content.setCursor(0, 5, true);
        content.composeHandler(new Event('compositionstart'));
        const autoPair = vi.spyOn(content, 'autoPair');

        content.inputHandler(new Event('input'));

        expect(autoPair).not.toHaveBeenCalled();
        expect(content.text).toBe('const a = 1');
    });

    it('inputHandler runs normally when not composing', () => {
        const muya = bootMuya('```js\nconst a = 1\n```\n');
        const content = codeContent(muya);
        muya.editor.activeContentBlock = content;
        content.setCursor(0, 5, true);
        const autoPair = vi.spyOn(content, 'autoPair');

        content.inputHandler(new Event('input'));

        expect(autoPair).toHaveBeenCalled();
    });

    const keyCases = [
        { key: 'Enter', handler: 'enterHandler' },
        { key: 'Backspace', handler: 'backspaceHandler' },
        { key: 'Delete', handler: 'deleteHandler' },
        { key: 'Tab', handler: 'tabHandler' },
        { key: 'ArrowLeft', handler: 'arrowHandler' },
    ] as const;

    it.each(keyCases)('preventDefaults $key and skips $handler while composing', ({ key, handler }) => {
        const muya = bootMuya('```js\nconst a = 1\n```\n');
        const content = codeContent(muya);
        muya.editor.activeContentBlock = content;
        content.setCursor(0, 5, true);
        content.composeHandler(new Event('compositionstart'));
        const spy = vi.spyOn(content, handler);

        const event = pressKey(content, key);

        expect(spy).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(true);
        expect(content.text).toBe('const a = 1');
    });

    it.each(keyCases)('runs $handler normally when not composing', ({ key, handler }) => {
        const muya = bootMuya('```js\nconst a = 1\n```\n');
        const content = codeContent(muya);
        muya.editor.activeContentBlock = content;
        content.setCursor(0, 5, true);
        const spy = vi.spyOn(content, handler);

        pressKey(content, key);

        expect(spy).toHaveBeenCalled();
    });
});
