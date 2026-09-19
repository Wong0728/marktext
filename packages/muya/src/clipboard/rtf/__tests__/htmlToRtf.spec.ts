// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { getClipBoardHtml } from '../../../utils/marked/getClipboardHtml';
import { htmlToRtf } from '../htmlToRtf';
import { ommlToRtf } from '../ommlToRtf';

// "Copy as Rich Text" additionally carries the content as RTF so desktop
// Word — whose HTML paste filter ignores MathML — pastes native OMML
// equations. The RTF control-word shape (`{\mmath{\*\moMath{\mr x}}}`,
// `{\mf{\mfPr...}{\mnum...}{\mden...}}`) is verified against Word's own
// clipboard output; these specs pin the converter side.

const BASE_OPTIONS = { math: true, frontMatter: true, mathRenderMode: 'mathml' as const };

describe('ommlToRtf', () => {
    it('maps runs and superscripts to \\mmath groups', () => {
        const rtf = ommlToRtf(
            '<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">'
            + '<m:r><m:t>x</m:t></m:r>'
            + '<m:sSup><m:e><m:r><m:t>y</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup>'
            + '</m:oMath>',
        );
        expect(rtf).toBe('{\\mmath{\\*\\moMath{\\mr x}{\\msSup{\\me{\\mr y}}{\\msup{\\mr 2}}}}}');
    });

    it('keeps fraction structure with mnum/mden', () => {
        const rtf = ommlToRtf(
            '<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">'
            + '<m:f><m:num><m:r><m:t>a</m:t></m:r></m:num><m:den><m:r><m:t>b</m:t></m:r></m:den></m:f>'
            + '</m:oMath>',
        );
        expect(rtf).toBe('{\\mmath{\\*\\moMath{\\mf{\\mnum{\\mr a}}{\\mden{\\mr b}}}}}');
    });

    it('escapes RTF specials and non-ASCII text', () => {
        const rtf = ommlToRtf(
            '<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">'
            + '<m:r><m:t>a\\b, 角, }{</m:t></m:r></m:oMath>',
        );
        expect(rtf).toContain('a\\\\b');
        // CJK escapes use the signed 16-bit form (35282 - 65536).
        expect(rtf).toContain('\\uc1\\u-30254 ?'); // 角
        expect(rtf).toContain('\\}\\{');
    });

    it('returns empty for non-oMath input', () => {
        expect(ommlToRtf('<div>nope</div>')).toBe('');
    });
});

describe('htmlToRtf — clipboard html with inline math', () => {
    it('converts the user-style paragraph: text + inline formulas + CJK', () => {
        const md = '设 $O$ 为交点，且 $OA=a$，$b>a>0$。';
        const html = getClipBoardHtml(md, BASE_OPTIONS);
        const rtf = htmlToRtf(html);

        expect(rtf.startsWith('{\\rtf1\\ansi')).toBe(true);
        expect(rtf).toContain('{\\mmath{\\*\\moMath');
        // Three formulas → three equation groups.
        expect(rtf.split('\\mmath').length - 1).toBe(3);
        // CJK text survived as signed \uN escapes (35774 - 65536).
        expect(rtf).toContain('\\uc1\\u-29762 ?'); // 设
        // Paragraph break present.
        expect(rtf).toContain('\\par');
    });

    it('renders display math via an equation group too', () => {
        const html = getClipBoardHtml('$$E=mc^2$$', BASE_OPTIONS);
        const rtf = htmlToRtf(html);
        expect(rtf).toContain('{\\mmath{\\*\\moMath');
        expect(rtf).not.toContain('<math');
    });

    it('carries bold text as \\b groups', () => {
        const rtf = htmlToRtf(getClipBoardHtml('plain **bold** end', BASE_OPTIONS));
        expect(rtf).toContain('{\\b bold}');
    });
});
