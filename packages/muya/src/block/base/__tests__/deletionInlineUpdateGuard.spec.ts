// @vitest-environment happy-dom

import type { Muya } from '../../../muya';
import type Format from '../format';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Muya as MuyaClass } from '../../../muya';

vi.mock('../../../utils/prism/index', () => ({
    default: {},
    walkTokens: () => null,
    loadedLanguages: new Set(),
    transformAliasToOrigin: (s: string) => s,
    loadLanguage: () => null,
    search: () => [],
}));

// Deletion-mode `checkInlineUpdate`: a same-block native deletion (Backspace
// over a selection) reaches `Format.inputHandler` and re-evaluates the block
// type from the surviving text. A marker merely EXPOSED on a soft line must not
// split or re-type the block; typing the marker still does.

const bootedHosts: HTMLElement[] = [];
let hadVersion = false;
let originalVersion: string | undefined;

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
    const muya = new MuyaClass(host, { markdown } as ConstructorParameters<typeof MuyaClass>[1]);
    muya.init();
    bootedHosts.push(muya.domNode);
    return muya;
}

function firstContent(muya: Muya): Format {
    return muya.editor.scrollPage!.firstContentInDescendant() as unknown as Format;
}

function firstChildName(muya: Muya): string {
    return muya.editor.scrollPage!.firstChild!.blockName;
}

describe('inputHandler — deletion-exposed soft-line markers do not convert', () => {
    it('deleting "tag" from `foo\\n#tag` leaves the paragraph intact', async () => {
        const muya = bootMuya('foo\n#tag\n');
        const content = firstContent(muya);

        // Emulate the native deletion: the browser removed `tag` from the DOM
        // and collapsed the caret before the `input` event reaches the block.
        content.domNode!.textContent = 'foo\n#';
        content.setCursor(4, 4);
        content.inputHandler({
            type: 'input',
            inputType: 'deleteContentBackward',
        } as unknown as InputEvent);

        expect(firstChildName(muya)).toBe('paragraph');
        // json1 ops flush to the document state on the next animation frame.
        await vi.waitFor(() => {
            expect(muya.getMarkdown()).toBe('foo\n#\n');
        });
    });
});

describe('typing still converts (positive controls for the deletion guard)', () => {
    it('typing a heading marker on a soft line still splits the block', () => {
        const muya = bootMuya('seed\n');
        const content = firstContent(muya);
        content.text = 'foo\n# ';
        content.checkInlineUpdate();

        // The conversion splits `foo` off as a leading paragraph; the heading
        // is the block after it.
        const names: string[] = [];
        muya.editor.scrollPage!.forEach(block => names.push(block.blockName));
        expect(names).toContain('atx-heading');
        expect(names).toContain('paragraph');
    });

    it('typing a setext underline still re-types the block (^-anchored fragment)', () => {
        // The setext fragment is anchored at the block start and the underline
        // applies to the whole block, so `foo\n---` converts on typing AND on
        // deletion alike — muyajs parity (cutBlockConvert.spec.ts).
        const muya = bootMuya('seed\n');
        const content = firstContent(muya);
        content.text = 'foo\n---';
        content.checkInlineUpdate();

        expect(firstChildName(muya)).toBe('setext-heading');
    });
});
