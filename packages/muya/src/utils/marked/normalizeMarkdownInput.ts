/**
 * Prepare Markdown for Marked without changing the document saved on disk.
 *
 * Marked tokenizes block syntax around LF boundaries. It can also treat a
 * standalone `$$` immediately after paragraph or quote text as a lazy
 * continuation instead of the start of a display-math block. Normalize line
 * endings and give standalone display-math fences an explicit block boundary.
 */
export function normalizeMarkdownInput(src: string): string {
    const lines = src.replace(/\r\n?/g, '\n').split('\n');
    const normalized: string[] = [];
    let codeFence: string | undefined;
    let mathBlock = false;

    for (const line of lines) {
        const trimmed = line.trim();
        const fence = /^(`{3,}|~{3,})/.exec(trimmed)?.[1];

        if (fence) {
            if (codeFence) {
                if (fence[0] === codeFence[0] && fence.length >= codeFence.length)
                    codeFence = undefined;
            }
            else {
                codeFence = fence;
            }
            normalized.push(line);
            continue;
        }

        if (!codeFence && trimmed === '$$') {
            if (!mathBlock && normalized.length > 0 && normalized[normalized.length - 1].trim())
                normalized.push('');
            mathBlock = !mathBlock;
        }

        normalized.push(line);
    }

    return normalized.join('\n');
}
