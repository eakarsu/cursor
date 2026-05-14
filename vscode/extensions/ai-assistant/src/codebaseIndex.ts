import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { chunkBySyntax, SyntaxChunk } from './syntaxChunker';
import { getEmbeddingProvider, cosine, EmbeddingProvider } from './embeddings';

interface Chunk {
	id: number;
	file: string;
	startLine: number;
	endLine: number;
	text: string;
	tokens: Map<string, number>;
	length: number;
	embedding?: number[];
}

const SKIP_DIRS = new Set([
	'node_modules', '.git', 'out', 'dist', 'build', '.next', '.cache', 'target', 'venv',
	'__pycache__', '.venv', '.gradle', '.idea', '.vscode-test', 'coverage',
]);

const EXT_LANG: Record<string, string> = {
	'.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
	'.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript',
	'.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java', '.kt': 'kotlin',
	'.swift': 'swift', '.c': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.h': 'cpp', '.hpp': 'cpp',
	'.cs': 'csharp', '.rb': 'ruby', '.php': 'php',
	'.md': 'markdown', '.txt': 'text', '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml',
	'.sql': 'sql', '.sh': 'bash', '.zsh': 'bash', '.bash': 'bash',
};

function tokenize(s: string): string[] {
	return s.toLowerCase().match(/[a-z_][a-z0-9_]{1,40}/g) ?? [];
}

async function loadIgnorePatterns(root: string): Promise<RegExp[]> {
	const out: RegExp[] = [];
	for (const name of ['.cursorignore', '.aicodeignore']) {
		try {
			const txt = await fs.readFile(path.join(root, name), 'utf8');
			for (const raw of txt.split('\n')) {
				const line = raw.trim();
				if (!line || line.startsWith('#')) { continue; }
				out.push(globToRegex(line));
			}
		} catch { /* not present */ }
	}
	return out;
}

function globToRegex(glob: string): RegExp {
	let g = glob.replace(/\\/g, '/');
	if (g.endsWith('/')) { g = g + '**'; }
	const re = g
		.replace(/[.+^${}()|[\]]/g, '\\$&')
		.replace(/\*\*/g, '§§')
		.replace(/\*/g, '[^/]*')
		.replace(/§§/g, '.*')
		.replace(/\?/g, '[^/]');
	return new RegExp('^' + re + '($|/)');
}

export class CodebaseIndex {
	private chunks: Chunk[] = [];
	private df = new Map<string, number>();
	private avgLen = 0;
	private root: string | undefined;
	private ready = false;
	private buildingPromise: Promise<void> | undefined;
	private embedder: EmbeddingProvider | undefined;
	private hasEmbeddings = false;
	private ignorePatterns: RegExp[] = [];

	get isReady(): boolean { return this.ready; }
	get chunkCount(): number { return this.chunks.length; }
	get fileCount(): number { return new Set(this.chunks.map(c => c.file)).size; }
	get embeddingsReady(): boolean { return this.hasEmbeddings; }

	async ensureBuilt(): Promise<void> {
		if (this.ready) { return; }
		if (this.buildingPromise) { return this.buildingPromise; }
		this.buildingPromise = this.build();
		try { await this.buildingPromise; } finally { this.buildingPromise = undefined; }
	}

	async build(): Promise<void> {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) { return; }
		this.root = folder.uri.fsPath;
		this.chunks = [];
		this.df.clear();
		this.embedder = getEmbeddingProvider();
		this.ignorePatterns = await loadIgnorePatterns(this.root);

		const maxBytes = vscode.workspace.getConfiguration('aiAssistant').get<number>('codebaseIndex.maxFileBytes', 200000);
		await this.walk(this.root, maxBytes);

		// BM25 stats
		for (const c of this.chunks) {
			for (const t of c.tokens.keys()) {
				this.df.set(t, (this.df.get(t) ?? 0) + 1);
			}
		}
		this.avgLen = this.chunks.reduce((a, c) => a + c.length, 0) / Math.max(1, this.chunks.length);

		// Embeddings (best-effort)
		if (this.embedder && this.chunks.length) {
			try {
				const texts = this.chunks.map(c => `// ${c.file}\n${c.text}`);
				const vecs = await this.embedder.embed(texts.slice(0, 4000), 'document');
				for (let i = 0; i < vecs.length; i++) { this.chunks[i].embedding = vecs[i]; }
				this.hasEmbeddings = true;
			} catch (e: any) {
				console.warn('Embedding build failed, falling back to BM25:', e?.message);
			}
		}
		this.ready = true;
	}

	private async walk(dir: string, maxBytes: number): Promise<void> {
		let entries: any[] = [];
		try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
		for (const e of entries) {
			if (SKIP_DIRS.has(e.name) || (e.name.startsWith('.') && e.name !== '.aicode')) { continue; }
			const full = path.join(dir, e.name);
			const relPath = path.relative(this.root!, full).replace(/\\/g, '/');
			if (this.ignorePatterns.some(p => p.test(relPath))) { continue; }
			if (e.isDirectory()) {
				await this.walk(full, maxBytes);
			} else if (e.isFile()) {
				const ext = path.extname(e.name).toLowerCase();
				const lang = EXT_LANG[ext];
				if (!lang) { continue; }
				try {
					const stat = await fs.stat(full);
					if (stat.size > maxBytes) { continue; }
					const text = await fs.readFile(full, 'utf8');
					const rel = path.relative(this.root!, full);
					const syntaxChunks = chunkBySyntax(text, lang);
					for (const sc of syntaxChunks) {
						this.chunks.push(this.toChunk(rel, sc));
					}
				} catch { /* skip */ }
			}
		}
	}

	private toChunk(file: string, sc: SyntaxChunk): Chunk {
		const toks = tokenize(sc.text);
		const counts = new Map<string, number>();
		for (const t of toks) { counts.set(t, (counts.get(t) ?? 0) + 1); }
		return {
			id: this.chunks.length,
			file,
			startLine: sc.startLine,
			endLine: sc.endLine,
			text: sc.text,
			tokens: counts,
			length: toks.length,
		};
	}

	bm25Score(query: string, c: Chunk): number {
		const qToks = tokenize(query);
		const N = this.chunks.length;
		const k1 = 1.5, b = 0.75;
		let score = 0;
		for (const qt of qToks) {
			const tf = c.tokens.get(qt) ?? 0;
			if (!tf) { continue; }
			const df = this.df.get(qt) ?? 1;
			const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
			const norm = tf * (k1 + 1) / (tf + k1 * (1 - b + b * c.length / Math.max(1, this.avgLen)));
			score += idf * norm;
		}
		return score;
	}

	async search(query: string, k = 8): Promise<Array<{ file: string; startLine: number; endLine: number; text: string; score: number }>> {
		if (!this.ready) { return []; }
		const bm25Scores = this.chunks.map(c => ({ chunk: c, bm25: this.bm25Score(query, c), cos: 0 }));
		const maxBM = Math.max(1e-9, ...bm25Scores.map(s => s.bm25));

		// Embedding scores (if available)
		if (this.hasEmbeddings && this.embedder) {
			try {
				const [qVec] = await this.embedder.embed([query], 'query');
				for (const s of bm25Scores) {
					if (s.chunk.embedding) { s.cos = cosine(qVec, s.chunk.embedding); }
				}
			} catch { /* fall through */ }
		}

		const maxCos = Math.max(1e-9, ...bm25Scores.map(s => s.cos));
		const ranked = bm25Scores
			.map(s => ({ chunk: s.chunk, score: 0.4 * (s.bm25 / maxBM) + 0.6 * (s.cos / maxCos) }))
			.filter(s => s.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, k);

		return ranked.map(s => ({
			file: s.chunk.file,
			startLine: s.chunk.startLine,
			endLine: s.chunk.endLine,
			text: s.chunk.text,
			score: s.score,
		}));
	}

	async formatContext(query: string, k = 6): Promise<string> {
		if (vscode.workspace.getConfiguration('aiAssistant').get<boolean>('privacyMode', false)) { return ''; }
		const hits = await this.search(query, k);
		if (!hits.length) { return ''; }
		return hits.map(h => `// ${h.file}:${h.startLine + 1}-${h.endLine + 1}\n${h.text}`).join('\n\n---\n\n');
	}

	// Synchronous BM25-only fallback for callers that can't await
	formatContextSync(query: string, k = 6): string {
		if (vscode.workspace.getConfiguration('aiAssistant').get<boolean>('privacyMode', false)) { return ''; }
		if (!this.ready) { return ''; }
		const ranked = this.chunks
			.map(c => ({ chunk: c, score: this.bm25Score(query, c) }))
			.filter(s => s.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, k);
		if (!ranked.length) { return ''; }
		return ranked.map(s => `// ${s.chunk.file}:${s.chunk.startLine + 1}-${s.chunk.endLine + 1}\n${s.chunk.text}`).join('\n\n---\n\n');
	}
}
