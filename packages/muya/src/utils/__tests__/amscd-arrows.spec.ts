// @vitest-environment happy-dom

import { execFileSync } from 'child_process';
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, expect, it } from 'vitest';
import { renderMath } from '../katex';

// Test which arrow approaches survive the pandoc HTML→DOCX→text round trip.
// Pandoc converts MathML → OMML (in DOCX) → LaTeX notation (in plain text).
// If the arrow's LaTeX command appears in the round-trip text, pandoc
// successfully converted it to OMML. If it's missing, pandoc dropped it.

const PANDOC = 'pandoc';

interface ArrowVariant {
    name: string;
    tex: string;
    /** Substring expected in round-trip text (LaTeX notation from OMML). */
    expectInText: string[];
}

const variants: ArrowVariant[] = [
    { name: 'bare-downarrow', tex: String.raw`\begin{array}{cc} A & B \\ \downarrow & \downarrow \\ C & D \end{array}`, expectInText: ['downarrow'] },
    { name: 'big-downarrow', tex: String.raw`\begin{array}{cc} A & B \\ \big\downarrow & \big\downarrow \\ C & D \end{array}`, expectInText: ['downarrow'] },
    { name: 'Big-downarrow', tex: String.raw`\begin{array}{cc} A & B \\ \Big\downarrow & \Big\downarrow \\ C & D \end{array}`, expectInText: ['downarrow'] },
    { name: 'big-downarrow-underset', tex: String.raw`\begin{array}{cc} A & B \\ \underset{g}{\big\downarrow} & \underset{h}{\big\downarrow} \\ C & D \end{array}`, expectInText: ['downarrow', 'g'] },
    { name: 'xrightarrow', tex: String.raw`A \xrightarrow{f} B`, expectInText: ['rightarrow', 'f'] },
    { name: 'full-CD', tex: String.raw`\begin{CD} A @>f>> B \\ @VgVV @VVhV \\ C @>>k> D \end{CD}`, expectInText: ['rightarrow', 'downarrow', 'f', 'g', 'h', 'k'] },
];

function roundTripThroughDocx(html: string): string {
    const tmpDir = join(tmpdir(), `mt-arrow-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    const htmlPath = join(tmpDir, 'in.html');
    const docxPath = join(tmpDir, 'out.docx');
    writeFileSync(htmlPath, html, 'utf8');
    try {
        execFileSync(PANDOC, ['-f', 'html', '-t', 'docx', '--wrap=none', '-o', docxPath, htmlPath], {
            timeout: 30000, encoding: 'utf8',
        });
        if (!existsSync(docxPath)) throw new Error('pandoc did not produce DOCX');
        return execFileSync(PANDOC, ['-f', 'docx', '-t', 'plain', docxPath], {
            timeout: 30000, encoding: 'utf8',
        });
    } finally {
        try { unlinkSync(htmlPath); } catch {}
        try { unlinkSync(docxPath); } catch {}
    }
}

describe('AMSCD arrow MathML → pandoc OMML round-trip', () => {
    for (const v of variants) {
        it(`${v.name}: arrows survive DOCX round trip`, () => {
            const html = renderMath(v.tex, { displayMode: true, throwOnError: true });
            expect(html).not.toContain('katex-error');

            const mathmlMatch = html.match(/<math[\s\S]*?<\/math>/);
            expect(mathmlMatch, `no <math> for ${v.name}`).not.toBeNull();
            const fullHtml = `<!DOCTYPE html><html><body>${mathmlMatch![0]}</body></html>`;

            const text = roundTripThroughDocx(fullHtml);
            expect(text.length, `${v.name}: round-trip text empty`).toBeGreaterThan(0);

            for (const expected of v.expectInText) {
                expect(
                    text.toLowerCase(),
                    `${v.name}: expected "${expected}" in round-trip text, got: ${text}`,
                ).toContain(expected);
            }
        });
    }
});
