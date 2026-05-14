// Heuristic syntax-aware chunker. Tree-sitter would be ideal but adds a heavy native dep.
// We use language-specific regex anchors to break files at function/class/method boundaries.

export interface SyntaxChunk {
	startLine: number;
	endLine: number;
	text: string;
	header?: string; // function/class signature
}

const ANCHORS: Record<string, RegExp> = {
	typescript: /^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const\s+\w+\s*=\s*(?:async\s+)?\([^)]*\)\s*=>|abstract\s+class|namespace)\s+/m,
	javascript: /^(?:export\s+)?(?:async\s+)?(?:function|class|const\s+\w+\s*=\s*(?:async\s+)?\([^)]*\)\s*=>)\s+/m,
	python: /^(?:async\s+)?(?:def|class)\s+/m,
	go: /^(?:func|type)\s+/m,
	rust: /^(?:pub\s+)?(?:async\s+)?(?:fn|struct|enum|impl|trait)\s+/m,
	java: /^\s*(?:public|private|protected|static|\s)+\s*[\w<>,\s\[\]]+\s+\w+\s*\([^)]*\)\s*\{/m,
	csharp: /^\s*(?:public|private|internal|protected|static|\s)+\s*[\w<>,\s\[\]]+\s+\w+\s*\([^)]*\)/m,
	cpp: /^[\w:<>~&*\s]+\s+[\w:]+\s*\([^)]*\)\s*(?:const)?\s*\{/m,
	c: /^[\w*\s]+\s+\w+\s*\([^)]*\)\s*\{/m,
	ruby: /^(?:def|class|module)\s+/m,
	php: /^(?:public|private|protected)?\s*function\s+\w+/m,
	swift: /^(?:func|class|struct|enum|protocol|extension)\s+/m,
	kotlin: /^(?:fun|class|object|interface)\s+/m,
};

const TARGET_LINES = 80;
const MAX_LINES = 200;
const MIN_LINES = 10;

export function chunkBySyntax(text: string, language: string): SyntaxChunk[] {
	const anchor = ANCHORS[language];
	const lines = text.split('\n');

	if (!anchor) {
		return chunkByFixedSize(lines);
	}

	// Find anchor line indices
	const anchors: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (anchor.test(lines[i])) { anchors.push(i); }
	}
	if (anchors.length < 2) { return chunkByFixedSize(lines); }

	const chunks: SyntaxChunk[] = [];
	for (let i = 0; i < anchors.length; i++) {
		const start = anchors[i];
		const end = (i + 1 < anchors.length ? anchors[i + 1] : lines.length) - 1;
		const len = end - start + 1;
		if (len > MAX_LINES) {
			// split overlong block by fixed window
			for (let j = start; j <= end; j += TARGET_LINES) {
				const subEnd = Math.min(end, j + TARGET_LINES - 1);
				chunks.push({ startLine: j, endLine: subEnd, text: lines.slice(j, subEnd + 1).join('\n'), header: lines[start].trim() });
			}
		} else {
			chunks.push({ startLine: start, endLine: end, text: lines.slice(start, end + 1).join('\n'), header: lines[start].trim() });
		}
	}
	// Prepend any prelude before the first anchor
	if (anchors[0] > MIN_LINES) {
		chunks.unshift({ startLine: 0, endLine: anchors[0] - 1, text: lines.slice(0, anchors[0]).join('\n') });
	}
	return chunks;
}

function chunkByFixedSize(lines: string[]): SyntaxChunk[] {
	const chunks: SyntaxChunk[] = [];
	const STEP = TARGET_LINES - 10; // overlap
	for (let i = 0; i < lines.length; i += STEP) {
		const end = Math.min(lines.length - 1, i + TARGET_LINES - 1);
		chunks.push({ startLine: i, endLine: end, text: lines.slice(i, end + 1).join('\n') });
		if (end === lines.length - 1) { break; }
	}
	return chunks;
}
