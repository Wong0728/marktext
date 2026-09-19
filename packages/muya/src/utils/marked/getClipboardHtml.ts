import type { ILexOption } from './types';
import { Marked } from 'marked';
import { EXPORT_DOMPURIFY_CONFIG } from '../../config';
import { sanitize } from '../index';
import cjkEmStrongExtension from './extensions/cjkEmStrong';
import footnoteExtension from './extensions/footnote';
import mathExtension from './extensions/math';
import superSubScriptExtension from './extensions/superSubscript';
import fm, { frontMatterRender } from './frontMatter';
import { DEFAULT_OPTIONS } from './options';
import { normalizeMarkdownInput } from './normalizeMarkdownInput';
import walkTokens from './walkTokens';

export function getClipBoardHtml(src: string, options: ILexOption = {}) {
    // Match the live and static render paths for content copied from a
    // Windows-authored document.
    src = normalizeMarkdownInput(src);
    options = Object.assign({}, DEFAULT_OPTIONS, options);
    const { footnote, frontMatter, math, isGitlabCompatibilityEnabled, superSubScript, mathRenderMode }
        = options;
    let html = '';

    // Use a fresh Marked instance per call to avoid polluting the global
    // `marked` singleton — `.use({ walkTokens })` chains rather than replaces,
    // and the global is shared with anything else in the bundle that imports
    // `marked`.
    const marked = new Marked();

    marked.use({
        walkTokens: walkTokens({ math, isGitlabCompatibilityEnabled }),
    });

    // CJK-as-punctuation emphasis flanking (marktext/marktext#4307); keeps the
    // clipboard HTML consistent with the static / export render path.
    marked.use(cjkEmStrongExtension());

    if (math) {
        const mathRenderAsMathml = mathRenderMode === 'mathml';
        marked.use(
            mathExtension({
                throwOnError: false,
                // Standalone MathML for the rich-text clipboard (Word/Docs
                // convert it into a native equation object); literal `$…$`
                // text otherwise, matching the export render path.
                useKatexRender: mathRenderAsMathml,
                mathOutput: mathRenderAsMathml ? 'mathml' : 'html',
            }),
        );
    }

    if (superSubScript)
        marked.use(superSubScriptExtension());

    if (footnote)
        marked.use(footnoteExtension());

    if (frontMatter) {
        const { token, src: newSrc } = fm(src);
        if (token) {
            html = frontMatterRender(token);
            src = newSrc;
        }
    }

    html += marked.parse(src);

    return html;
}

export function getSanitizeClipboardHtml(src: string, options: ILexOption = {}) {
    const html = getClipBoardHtml(src, options);

    return sanitize(html, EXPORT_DOMPURIFY_CONFIG, false) as string;
}
