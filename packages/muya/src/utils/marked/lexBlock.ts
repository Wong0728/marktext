import type { Token } from 'marked';
import type { IFrontmatterToken, ILexOption, TLexedToken } from './types';
import { Marked } from 'marked';
import compatibleTaskList from './compatibleTaskList';
import footnoteExtension from './extensions/footnote';
import githubAlertsExtension, { normalizeGithubAlertTokens } from './extensions/githubAlerts';
import mathExtension, { bracketBlockMathExtension, doubleBackslashMathExtension, gfmMathExtension, singleBackslashMathExtension } from './extensions/math';
import multilineBlockquoteExtension from './extensions/multilineBlockquote';
import fm from './frontMatter';
import { normalizeMarkdownInput } from './normalizeMarkdownInput';
import { DEFAULT_OPTIONS } from './options';
import walkTokens from './walkTokens';

export function lexBlock(
    src: string,
    options: ILexOption = DEFAULT_OPTIONS,
): TLexedToken[] {
    // Marked's block tokenizer and our math extension both use LF-oriented
    // rules. Normalize Windows and legacy-Mac newlines before tokenization so
    // a CRLF document cannot turn headings and display math into plain text.
    src = normalizeMarkdownInput(src);
    options = Object.assign({}, DEFAULT_OPTIONS, options);
    const { texMathDollars, texMathGfm, texMathSingleBackslash, texMathDoubleBackslash, frontMatter, footnote, multilineBlockquote } = options;
    let tokens: (Token | IFrontmatterToken)[] = [];

    // Per-call Marked instances prevent enabled extensions leaking into later calls.
    const m = new Marked();

    if (texMathDollars) {
        m.use(
            mathExtension({
                throwOnError: false,
                useKatexRender: false,
                // State building keeps the authored syntax: a same-line
                // `$$…$$` stays paragraph-level inline math and the editor's
                // own display rule decides how it draws (#4904).
                authoredDisplayMath: false,
                texMathSingleBackslash,
            }),
        );
    }

    if (texMathGfm) {
        m.use(
            gfmMathExtension({
                throwOnError: false,
                useKatexRender: false,
            }),
        );
    }

    if (texMathSingleBackslash) {
        m.use(
            singleBackslashMathExtension({
                throwOnError: false,
                useKatexRender: false,
            }),
        );
    }
    else if (texMathSingleBackslash === undefined) {
        // No pandoc backslash mode picked: muya's own `\[...\]` display
        // delimiters stay math blocks on load, as they were before the
        // pandoc extensions arrived (#5481).
        m.use(
            bracketBlockMathExtension({
                throwOnError: false,
                useKatexRender: false,
            }),
        );
    }

    if (texMathDoubleBackslash) {
        m.use(
            doubleBackslashMathExtension({
                throwOnError: false,
                useKatexRender: false,
            }),
        );
    }

    if (footnote) {
        m.use(footnoteExtension());
    }

    m.use(multilineBlockquoteExtension(multilineBlockquote === true));

    if (frontMatter) {
        const { token, src: newSrc } = fm(src);
        if (token) {
            tokens.push(token);
            src = newSrc;
        }
    }

    // Lexer must receive this instance’s defaults to see its registered extensions.
    m.use(githubAlertsExtension(options.githubAlerts === true));
    const lexer = new m.Lexer(m.defaults);
    const parsed = lexer.blockTokens(src);
    tokens.push(...parsed);
    tokens = compatibleTaskList(tokens as Token[]);
    if (options.githubAlerts)
        normalizeGithubAlertTokens(tokens as Token[], lexer);
    m.walkTokens(tokens as Token[], walkTokens(options));

    // walkTokens and compatibleTaskList populate Muya fields absent from marked’s declared token types.
    return tokens as TLexedToken[];
}
