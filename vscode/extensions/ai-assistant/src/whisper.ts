import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as cp from 'child_process';

const WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions';
const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin';
const MODEL_FILE = 'ggml-base.en.bin';

let extContext: vscode.ExtensionContext | undefined;

export function init(context: vscode.ExtensionContext): void {
	extContext = context;
}

async function which(bin: string): Promise<string | undefined> {
	return await new Promise(resolve => {
		const c = cp.spawn(process.platform === 'win32' ? 'where' : 'which', [bin]);
		let out = '';
		c.stdout?.on('data', d => { out += d.toString(); });
		c.on('close', code => resolve(code === 0 ? out.trim().split('\n')[0] : undefined));
		c.on('error', () => resolve(undefined));
	});
}

async function findWhisperBinary(): Promise<string | undefined> {
	for (const name of ['whisper-cli', 'whisper-cpp', 'whisper.cpp']) {
		const p = await which(name);
		if (p) { return p; }
	}
	return undefined;
}

async function modelPath(): Promise<string | undefined> {
	if (!extContext) { return undefined; }
	const dir = path.join(extContext.globalStorageUri.fsPath, 'whisper');
	await fs.mkdir(dir, { recursive: true });
	return path.join(dir, MODEL_FILE);
}

async function ensureModel(): Promise<string | undefined> {
	const target = await modelPath();
	if (!target) { return undefined; }
	try {
		const stat = await fs.stat(target);
		if (stat.size > 100_000_000) { return target; }
	} catch { /* download below */ }

	const ok = await vscode.window.showInformationMessage(
		'Voice input needs the whisper.cpp model (~142 MB, one-time download). Download now?',
		'Download', 'Cancel',
	);
	if (ok !== 'Download') { return undefined; }

	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'Downloading whisper model', cancellable: false },
		async (prog) => {
			const res = await fetch(MODEL_URL);
			if (!res.ok || !res.body) { throw new Error(`Download failed: ${res.status}`); }
			const total = Number(res.headers.get('content-length') ?? 0);
			const tmp = target + '.part';
			const fh = await fs.open(tmp, 'w');
			let received = 0;
			const reader = res.body.getReader();
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) { break; }
					await fh.write(value);
					received += value.length;
					if (total > 0) {
						prog.report({ message: `${(received / 1_048_576).toFixed(1)} / ${(total / 1_048_576).toFixed(0)} MB`, increment: (value.length / total) * 100 });
					}
				}
			} finally {
				await fh.close();
			}
			await fs.rename(tmp, target);
		},
	);
	return target;
}

async function transcribeLocal(audioFile: string): Promise<string> {
	const bin = await findWhisperBinary();
	if (!bin) { throw new Error('whisper-cli not installed'); }
	const model = await ensureModel();
	if (!model) { throw new Error('whisper model not available'); }

	return await new Promise<string>((resolve, reject) => {
		const args = ['-m', model, '-f', audioFile, '-nt', '-l', 'en', '--no-prints', '-otxt', '-of', audioFile];
		const c = cp.spawn(bin, args);
		let stderr = '';
		c.stdout?.on('data', () => { /* ignore */ });
		c.stderr?.on('data', d => { stderr += d.toString().slice(-1000); });
		c.on('error', e => reject(e));
		c.on('close', async code => {
			if (code !== 0) { reject(new Error(`whisper exit ${code}: ${stderr}`)); return; }
			try {
				const txt = await fs.readFile(audioFile + '.txt', 'utf8');
				await fs.unlink(audioFile + '.txt').catch(() => undefined);
				resolve(txt.trim());
			} catch (e: any) { reject(e); }
		});
	});
}

async function transcribeOpenAI(filePath: string): Promise<string> {
	const cfg = vscode.workspace.getConfiguration('aiAssistant');
	const apiKey = cfg.get<string>('openaiApiKey') || process.env.OPENAI_API_KEY;
	if (!apiKey) { throw new Error('No transcriber: install whisper-cpp (brew install whisper-cpp) or set aiAssistant.openaiApiKey.'); }
	const buf = await fs.readFile(filePath);
	const ext = filePath.toLowerCase().split('.').pop() ?? 'wav';
	const mime = ext === 'wav' ? 'audio/wav' : ext === 'mp3' ? 'audio/mpeg' : ext === 'ogg' ? 'audio/ogg' : `audio/${ext}`;
	const form = new FormData();
	form.append('file', new Blob([buf], { type: mime }), `audio.${ext}`);
	form.append('model', 'whisper-1');
	const res = await fetch(WHISPER_URL, { method: 'POST', headers: { authorization: `Bearer ${apiKey}` }, body: form });
	if (!res.ok) { throw new Error(`Whisper ${res.status}: ${await res.text()}`); }
	const json: any = await res.json();
	return json.text ?? '';
}

export async function transcribeFile(filePath: string): Promise<string> {
	const bin = await findWhisperBinary();
	if (bin) {
		try { return await transcribeLocal(filePath); }
		catch (e: any) {
			console.warn('local whisper failed, trying OpenAI:', e?.message);
		}
	} else {
		// Offer to install
		const cfg = vscode.workspace.getConfiguration('aiAssistant');
		const hasOpenai = !!(cfg.get<string>('openaiApiKey') || process.env.OPENAI_API_KEY);
		if (!hasOpenai) {
			const choice = await vscode.window.showInformationMessage(
				'Voice input needs whisper.cpp (local, free) or an OpenAI key.',
				'Install whisper.cpp', 'Cancel',
			);
			if (choice === 'Install whisper.cpp') {
				const term = vscode.window.createTerminal('AI: install whisper');
				term.show();
				term.sendText('brew install whisper-cpp');
				throw new Error('Run the install command, reload the window, then try again.');
			}
			throw new Error('No transcriber configured.');
		}
	}
	return await transcribeOpenAI(filePath);
}

export async function transcribe(audioBase64: string, mime: string): Promise<string> {
	const buf = Buffer.from(audioBase64, 'base64');
	const ext = mime.includes('webm') ? 'webm' : mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'mp4' : 'wav';
	const tmp = path.join(os.tmpdir(), `aiAssistant-${Date.now()}.${ext}`);
	await fs.writeFile(tmp, buf);
	try { return await transcribeFile(tmp); }
	finally { await fs.unlink(tmp).catch(() => undefined); }
}

interface RecorderTool {
	cmd: string;
	args: (outFile: string) => string[];
}

async function findRecorder(): Promise<RecorderTool | undefined> {
	if (await which('sox')) {
		return { cmd: 'sox', args: out => ['-d', '-r', '16000', '-c', '1', '-b', '16', out] };
	}
	if (await which('rec')) {
		return { cmd: 'rec', args: out => ['-r', '16000', '-c', '1', '-b', '16', out] };
	}
	if (await which('ffmpeg')) {
		if (process.platform === 'darwin') {
			return { cmd: 'ffmpeg', args: out => ['-y', '-loglevel', 'error', '-f', 'avfoundation', '-i', ':0', '-ac', '1', '-ar', '16000', out] };
		}
		if (process.platform === 'linux') {
			return { cmd: 'ffmpeg', args: out => ['-y', '-loglevel', 'error', '-f', 'pulse', '-i', 'default', '-ac', '1', '-ar', '16000', out] };
		}
		if (process.platform === 'win32') {
			return { cmd: 'ffmpeg', args: out => ['-y', '-loglevel', 'error', '-f', 'dshow', '-i', 'audio=Microphone', '-ac', '1', '-ar', '16000', out] };
		}
	}
	return undefined;
}

let active: { proc: cp.ChildProcess; outFile: string } | undefined;

export function isRecording(): boolean { return !!active; }

export async function startRecording(): Promise<void> {
	if (active) { return; }
	const tool = await findRecorder();
	if (!tool) {
		const choice = await vscode.window.showErrorMessage(
			'No audio recorder found. Install sox (recommended) or ffmpeg.',
			'Install sox via brew', 'Cancel',
		);
		if (choice === 'Install sox via brew') {
			const term = vscode.window.createTerminal('AI: install sox');
			term.show();
			term.sendText('brew install sox');
		}
		throw new Error('No recorder available');
	}
	const outFile = path.join(os.tmpdir(), `aiAssistant-rec-${Date.now()}.wav`);
	const proc = cp.spawn(tool.cmd, tool.args(outFile), { stdio: ['ignore', 'ignore', 'pipe'] });
	let stderr = '';
	proc.stderr?.on('data', d => { stderr += d.toString().slice(-400); });
	proc.on('error', e => {
		vscode.window.showErrorMessage(`Recorder error: ${e.message}`);
		active = undefined;
	});
	proc.on('close', code => {
		if (code !== 0 && code !== null && stderr) {
			console.log('recorder stderr:', stderr);
		}
	});
	active = { proc, outFile };
}

async function maxAmplitude(file: string): Promise<number> {
	const sox = await which('sox');
	if (!sox) { return 1; } // can't measure → assume non-silent
	return await new Promise(resolve => {
		const c = cp.spawn(sox, [file, '-n', 'stat']);
		let err = '';
		c.stderr?.on('data', d => { err += d.toString(); });
		c.on('close', () => {
			const m = err.match(/Maximum amplitude:\s+([0-9.]+)/);
			resolve(m ? parseFloat(m[1]) : 1);
		});
		c.on('error', () => resolve(1));
	});
}

async function offerMicPermission(): Promise<void> {
	if (process.platform !== 'darwin') {
		vscode.window.showErrorMessage('Recording captured silence. Check that your default mic is correct and the app has microphone permission.');
		return;
	}
	const choice = await vscode.window.showErrorMessage(
		'Recording was silent — Cursor/VS Code lacks microphone permission. macOS requires you to grant it in System Settings.',
		'Open Mic Settings', 'Cancel',
	);
	if (choice === 'Open Mic Settings') {
		cp.spawn('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone']);
	}
}

export async function stopAndTranscribe(): Promise<string | undefined> {
	if (!active) { return undefined; }
	const { proc, outFile } = active;
	active = undefined;
	await new Promise<void>(resolve => {
		const finish = (): void => resolve();
		proc.once('close', finish);
		try {
			if (process.platform === 'win32') { proc.kill(); }
			else { proc.kill('SIGINT'); }
		} catch { resolve(); }
		setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } resolve(); }, 1500);
	});
	try {
		const stat = await fs.stat(outFile);
		if (stat.size < 1000) {
			await fs.unlink(outFile).catch(() => undefined);
			throw new Error('Recording too short or empty.');
		}
		const amp = await maxAmplitude(outFile);
		if (amp < 0.005) {
			await fs.unlink(outFile).catch(() => undefined);
			void offerMicPermission();
			throw new Error('Recording was silent (no mic permission).');
		}
		const text = await transcribeFile(outFile);
		await fs.unlink(outFile).catch(() => undefined);
		return text;
	} catch (e) {
		await fs.unlink(outFile).catch(() => undefined);
		throw e;
	}
}
