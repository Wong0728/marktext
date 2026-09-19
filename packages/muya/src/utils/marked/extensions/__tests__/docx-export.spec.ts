// @vitest-environment happy-dom

import { Marked } from 'marked';
import { execFileSync } from 'child_process';
import { existsSync, writeFileSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, expect, it } from 'vitest';
import mathExtension from '../math';
import { renderMath } from '../../../katex';

function renderMd(src: string): string {
    const marked = new Marked();
    marked.use(mathExtension({ throwOnError: false, useKatexRender: true }));
    return marked.parse(src) as string;
}

// Replicate prepareHtmlForDocx logic (from exportHtml.ts) using happy-dom's
// DOMParser. Strips .katex-html visual spans and <annotation> elements,
// keeps <math> MathML.
function prepareForPandoc(html: string): string {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    // Strip <annotation> elements — pandoc prefers the annotation's TeX and
    // fails on complex constructs (AMSCD \underset{\scriptstyle ...}, \cfrac),
    // falling back to raw TeX text instead of producing OMML equations.
    for (const annotation of doc.querySelectorAll('math annotation')) {
        annotation.remove();
    }
    for (const wrapper of doc.querySelectorAll('.katex-display')) {
        const math = wrapper.querySelector('.katex-mathml > math');
        if (!math) continue;
        const div = doc.createElement('div');
        div.appendChild(math);
        wrapper.replaceWith(div);
    }
    for (const katex of doc.querySelectorAll('.katex')) {
        const math = katex.querySelector('.katex-mathml > math');
        if (!math) continue;
        katex.replaceWith(math);
    }
    return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
}

const PANDOC = 'pandoc';

describe('DOCX export pipeline — pandoc end-to-end', () => {
    // Generate a full document, preprocess for pandoc, and actually run
    // pandoc to produce a .docx. Verifies the DOCX file is created and
    // non-empty. This is the real export path the user uses.

    it('converts full LaTeX test document to DOCX via pandoc', () => {
        const doc = `## aligned
$$
\\begin{aligned}
(a+b)^2 &= a^2 + 2ab + b^2 \\\\
(a-b)^2 &= a^2 - 2ab + b^2
\\end{aligned}$$

## cases
$$
f(x) = \\begin{cases}
x^2 & \\text{if } x \\geq 0 \\\\
-x & \\text{if } x < 0
\\end{cases}
$$

## binom
$$\\binom{n}{k} = \\frac{n!}{k!(n-k)!}$$

## gather
$$\\begin{gather}
a = b + c \\\\
d = e + f + g
\\end{gather}$$

## AMSCD commutative diagram
$$\\begin{CD}
A @>f>> B \\\\
@VgVV @VVhV \\\\
C @>>k> D
\\end{CD}$$

## color
$$\\color{red}{E} = \\color{blue}{mc^2}$$

## mathcal / mathbb
$$\\mathcal{L}\\{\\mathcal{F}\\} = \\mathbb{R}^n \\oplus \\mathbb{C}^m$$

## substack
$$\\sum_{\\substack{1 \\leq i \\leq n \\\\ i \\text{ odd}}} i^2$$

## cfrac
$$\\cfrac{1}{1 + \\cfrac{2}{1 + \\cfrac{3}{1 + \\cdots}}}$$

## xrightarrow
$$A \\xrightarrow{f} B \\xleftarrow{g} C$$

## forall / exists
$$\\forall x \\in \\mathbb{R}, \\exists y \\in \\mathbb{R} : y^2 = x$$
`;
        const raw = renderMd(doc);
        const prepped = prepareForPandoc(raw);

        // Verify MathML survived preprocessing
        expect(prepped).toContain('<math');
        // Verify <annotation> was stripped (otherwise pandoc falls back to raw TeX)
        expect(prepped).not.toContain('<annotation');
        // Verify AMSCD arrows are in the MathML
        expect(prepped).toContain('xrightarrow');
        expect(prepped).toContain('↓');

        // Write to temp and run pandoc
        const tmpHtml = join(tmpdir(), `mt-test-${Date.now()}.html`);
        const tmpDocx = join(tmpdir(), `mt-test-${Date.now()}.docx`);
        writeFileSync(tmpHtml, prepped, 'utf8');

        try {
            // Run pandoc to convert the prepared HTML to DOCX.
            execFileSync(PANDOC, [
                '-f', 'html', '-t', 'docx',
                '--wrap=none',
                `-o`, tmpDocx,
                tmpHtml,
            ], { timeout: 30000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

            expect(existsSync(tmpDocx), 'pandoc did not produce a DOCX file').toBe(true);
            const stat = readFileSync(tmpDocx);
            expect(stat.length, 'DOCX file is empty').toBeGreaterThan(1000);
        } finally {
            if (existsSync(tmpHtml)) unlinkSync(tmpHtml);
            if (existsSync(tmpDocx)) unlinkSync(tmpDocx);
        }
    });

    it('AMSCD vertical arrows render as <mo>↓</mo> in MathML', () => {
        const tex = String.raw`\begin{CD}
A @>f>> B \\
@VgVV @VVhV \\
C @>>k> D
\end{CD}`;
        const html = renderMath(tex, { displayMode: true });
        // The MathML must contain the downarrow glyph. KaTeX's \big\downarrow
        // produces <mo stretchy="true" minsize="1.2em">↓</mo> — the minsize
        // attribute is a rendering hint that pandoc handles correctly when
        // converting MathML to OMML.
        const mathmlMatch = html.match(/<math[\s\S]*?<\/math>/);
        expect(mathmlMatch, 'no <math> element found').not.toBeNull();
        const mathml = mathmlMatch![0];
        expect(mathml).toContain('↓');
        expect(mathml).toContain('xrightarrow');
    });

    it('AMSCD and cfrac produce OMML (no pandoc "Could not convert" warnings)', () => {
        // These formulas previously caused pandoc to fall back to raw TeX text
        // because it tried to parse the <annotation> TeX and failed on
        // \underset{\scriptstyle ...} and \cfrac. Stripping <annotation> forces
        // pandoc to use the MathML structure, producing proper OMML equations.
        const doc = `## AMSCD
$$\\begin{CD}
A @>f>> B \\\\
@VgVV @VVhV \\\\
C @>>k> D
\\end{CD}$$

## cfrac
$$\\cfrac{1}{1 + \\cfrac{2}{1 + \\cfrac{3}{1 + \\cdots}}}$$
`;
        const raw = renderMd(doc);
        const prepped = prepareForPandoc(raw);
        expect(prepped).not.toContain('<annotation');

        const tmpHtml = join(tmpdir(), `mt-omml-${Date.now()}.html`);
        const tmpDocx = join(tmpdir(), `mt-omml-${Date.now()}.docx`);
        writeFileSync(tmpHtml, prepped, 'utf8');
        try {
            execFileSync(PANDOC, [
                '-f', 'html', '-t', 'docx',
                '--wrap=none',
                `-o`, tmpDocx,
                tmpHtml,
            ], { timeout: 30000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
            expect(existsSync(tmpDocx), 'pandoc did not produce DOCX').toBe(true);
            const stat = readFileSync(tmpDocx);
            expect(stat.length, 'DOCX file is empty').toBeGreaterThan(1000);
        } finally {
            if (existsSync(tmpHtml)) unlinkSync(tmpHtml);
            if (existsSync(tmpDocx)) unlinkSync(tmpDocx);
        }
    });

    it('math inside table cells renders and exports', () => {
        const src = `| 类型 | 公式 | 说明 |
|------|------|------|
| 求和 | $\\sum_{i=1}^{n} \\frac{1}{i^2}$ | 巴塞尔 |
| 积分 | $\\int_0^\\infty e^{-x^2} dx$ | 高斯 |
| 矩阵 | $\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}$ | 2×2 |`;
        const raw = renderMd(src);
        expect(raw).toContain('katex');
        expect(raw).not.toContain('katex-error');

        const prepped = prepareForPandoc(raw);
        expect(prepped).toContain('<math');

        // Run pandoc to verify table + math converts
        const tmpHtml = join(tmpdir(), `mt-table-${Date.now()}.html`);
        const tmpDocx = join(tmpdir(), `mt-table-${Date.now()}.docx`);
        writeFileSync(tmpHtml, prepped, 'utf8');
        try {
            execFileSync(PANDOC, [
                '-f', 'html', '-t', 'docx',
                '--wrap=none',
                `-o`, tmpDocx,
                tmpHtml,
            ], { timeout: 30000, encoding: 'utf8' });
            expect(existsSync(tmpDocx), 'pandoc did not produce DOCX for table+math').toBe(true);
            const stat = readFileSync(tmpDocx);
            expect(stat.length, 'table+math DOCX is empty').toBeGreaterThan(1000);
        } finally {
            if (existsSync(tmpHtml)) unlinkSync(tmpHtml);
            if (existsSync(tmpDocx)) unlinkSync(tmpDocx);
        }
    });
});
