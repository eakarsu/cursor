import * as vscode from 'vscode';

export interface EmbeddingProvider {
	name: string;
	dim: number;
	embed(texts: string[], type: 'document' | 'query'): Promise<number[][]>;
}

const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';
const OPENAI_URL = 'https://api.openai.com/v1/embeddings';

export function getEmbeddingProvider(): EmbeddingProvider | undefined {
	const cfg = vscode.workspace.getConfiguration('aiAssistant');
	const voyage = cfg.get<string>('voyageApiKey') || process.env.VOYAGE_API_KEY;
	const openai = cfg.get<string>('openaiApiKey') || process.env.OPENAI_API_KEY;
	if (voyage) {
		const model = cfg.get<string>('embeddings.voyageModel', 'voyage-code-3');
		return new VoyageProvider(voyage, model);
	}
	if (openai) {
		const model = cfg.get<string>('embeddings.openaiModel', 'text-embedding-3-small');
		return new OpenAIProvider(openai, model);
	}
	return undefined;
}

class VoyageProvider implements EmbeddingProvider {
	name = 'voyage';
	dim = 1024;
	constructor(private key: string, private model: string) { }
	async embed(texts: string[], type: 'document' | 'query'): Promise<number[][]> {
		// Voyage caps batch at 128 inputs and 320k tokens. Chunk if needed.
		const out: number[][] = [];
		for (let i = 0; i < texts.length; i += 64) {
			const batch = texts.slice(i, i + 64);
			const res = await fetch(VOYAGE_URL, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${this.key}` },
				body: JSON.stringify({ input: batch, model: this.model, input_type: type }),
			});
			if (!res.ok) { throw new Error(`Voyage ${res.status}: ${await res.text()}`); }
			const json: any = await res.json();
			for (const d of json.data ?? []) { out.push(d.embedding); }
		}
		return out;
	}
}

class OpenAIProvider implements EmbeddingProvider {
	name = 'openai';
	dim = 1536;
	constructor(private key: string, private model: string) { }
	async embed(texts: string[], _type: 'document' | 'query'): Promise<number[][]> {
		const out: number[][] = [];
		for (let i = 0; i < texts.length; i += 96) {
			const batch = texts.slice(i, i + 96);
			const res = await fetch(OPENAI_URL, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${this.key}` },
				body: JSON.stringify({ input: batch, model: this.model }),
			});
			if (!res.ok) { throw new Error(`OpenAI embed ${res.status}: ${await res.text()}`); }
			const json: any = await res.json();
			for (const d of json.data ?? []) { out.push(d.embedding); }
		}
		return out;
	}
}

export function cosine(a: number[], b: number[]): number {
	let dot = 0, na = 0, nb = 0;
	for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
	return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}
