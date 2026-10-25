// @vitest-environment happy-dom

import type Format from '../../block/base/format';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Muya } from '../../muya';

const bootedHosts: HTMLElement[] = [];

beforeEach(() => {
    window.MUYA_VERSION = 'test';
});

afterEach(() => {
    while (bootedHosts.length)
        bootedHosts.pop()!.remove();
    document.getSelection()?.removeAllRanges();
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

// The undo stack records the selection as of BEFORE each edit (the older of
// the two snapshots kept in `_selectionStack`). For the very first edit after
// boot/clear no pre-edit snapshot exists; the entry used to store `null`, so
// the first Ctrl+Z applied the inverse op but skipped `_restoreSelection`
// entirely, leaving the caret dangling after the pick/drop rebuild. It now
// falls back to the post-edit snapshot.

describe('history — the first undo restores a caret', () => {
    it('falls back to the post-edit selection for the first undo entry', async () => {
        const muya = bootMuya('seed\n');
        const content = muya.editor.scrollPage!.firstContentInDescendant() as unknown as Format;

        // Simulate a keystroke at the end of the block: text edit, then the
        // caret after the inserted char — the same order `inputHandler` uses.
        content.setCursor(4, 4, true);
        content.text = 'seedx';
        content.setCursor(5, 5, true);
        // json1 ops flush to the document state on the next animation frame.
        muya.editor.transactions.flush();
        await vi.waitFor(() => {
            expect(muya.getMarkdown()).toBe('seedx\n');
        });

        muya.editor.history.undo();

        expect(muya.getMarkdown()).toBe('seed\n');
        // The restored caret lands inside the reverted block. The post-edit
        // offset (5) overshoots the reverted text ('seed', 4 chars) — the
        // restore must clamp it instead of parking past the end.
        expect(muya.editor.selection.anchor?.offset).toBe(4);
        const live = muya.editor.selection.getSelection();
        expect(live?.anchor.offset).toBe(4);
    });
});
