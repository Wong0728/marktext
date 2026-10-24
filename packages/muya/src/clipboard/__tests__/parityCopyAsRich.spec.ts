// @vitest-environment happy-dom

import type { Muya } from '../../muya';
import { describe, expect, it, vi } from 'vitest';
import { CopyType } from '../types';

// The clipboard module pulls in CodeBlockContent → utils/prism which touches
// `window` at import time. Stub the prism shim so the test can run under Node.
vi.mock('../../utils/prism/index', () => ({
    default: {},
    walkTokens: () => null,
    loadedLanguages: new Set(),
    transformAliasToOrigin: (s: string) => s,
    loadLanguage: () => null,
    search: () => [],
}));

const Clipboard = (await import('../index')).default;

function makeEvent() {
    const setData = vi.fn();
    return {
        event: { clipboardData: { setData } } as unknown as ClipboardEvent,
        setData,
    };
}

function makeClipboard(html: string, text: string) {
    const clipboard = new Clipboard({} as Muya);
    clipboard.getClipboardData = () => ({ html, text });
    return clipboard;
}

describe('parity PG9: copyAsRich writes rendered HTML as rich text', () => {
    it('delegates non-math selections to the native rich clipboard', () => {
        const writeRichClipboard = vi.fn(() => true);
        const clipboard = makeClipboard('<p>selected</p>', 'selected');
        clipboard.muya.options = { writeRichClipboard };
        clipboard.copyType = CopyType.COPY_AS_RICH;
        const { event, setData } = makeEvent();
        clipboard.copyHandler(event);
        expect(writeRichClipboard).toHaveBeenCalledWith({ text: 'selected', html: '<p>selected</p>', rtf: '' });
        expect(setData).not.toHaveBeenCalled();
    });

    it('delegates an image-only rich selection rather than writing raw markdown', () => {
        const writeRichClipboard = vi.fn(() => true);
        const clipboard = new Clipboard({
            options: { writeRichClipboard },
            editor: { selection: { image: { token: { raw: '![diagram](images/model.svg)' } } } },
        } as unknown as Muya);
        clipboard.copyType = CopyType.COPY_AS_RICH;
        const { event, setData } = makeEvent();
        clipboard.copyHandler(event);
        expect(writeRichClipboard).toHaveBeenCalledWith(expect.objectContaining({ text: '![diagram](images/model.svg)' }));
        expect(setData).not.toHaveBeenCalled();
    });

    it('leaves the clipboard untouched for an empty selection', () => {
        const writeRichClipboard = vi.fn(() => true);
        const clipboard = makeClipboard('', '');
        clipboard.muya.options = { writeRichClipboard };
        clipboard.copyType = CopyType.COPY_AS_RICH;
        const { event, setData } = makeEvent();
        clipboard.copyHandler(event);
        expect(writeRichClipboard).not.toHaveBeenCalled();
        expect(setData).not.toHaveBeenCalled();
    });

    it(
        'PG9: copyAsRich sets text/html=rendered html AND text/plain=text',
        () => {
            const html = '<h1>Title</h1><p><strong>bold</strong></p>';
            const text = '# Title\n\n**bold**';
            const clipboard = makeClipboard(html, text);
            clipboard.copyType = CopyType.COPY_AS_RICH;
            const { event, setData } = makeEvent();

            clipboard.copyHandler(event);

            expect(setData).toHaveBeenCalledWith('text/html', html);
            expect(setData).toHaveBeenCalledWith('text/plain', text);
        },
    );

    it(
        'PG9: copyAsRich puts the rendered HTML in the text/html slot (unlike copyAsHtml)',
        () => {
            const html = '<p>rich</p>';
            const text = 'rich';

            // copyAsHtml (the current mapping target) blanks text/html and puts
            // the markup into text/plain — pasting yields literal markup.
            const asHtmlClip = makeClipboard(html, text);
            asHtmlClip.copyType = CopyType.COPY_AS_HTML;
            const asHtml = makeEvent();
            asHtmlClip.copyHandler(asHtml.event);
            const asHtmlHtmlSlot = asHtml.setData.mock.calls.find(
                c => c[0] === 'text/html',
            )?.[1];
            expect(asHtmlHtmlSlot).toBe('');

            // copyAsRich must instead place the real rendered HTML in the html
            // slot so a rich-text target renders it.
            const asRichClip = makeClipboard(html, text);
            asRichClip.copyType = CopyType.COPY_AS_RICH;
            const asRich = makeEvent();
            asRichClip.copyHandler(asRich.event);
            const asRichHtmlSlot = asRich.setData.mock.calls.find(
                c => c[0] === 'text/html',
            )?.[1];
            expect(asRichHtmlSlot).toBe(html);
        },
    );
});
