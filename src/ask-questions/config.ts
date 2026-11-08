import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { errorMessage } from '../shared.ts';

/**
 * Where the `ask_user` tool is exposed to the model:
 * - "all": every mode (default). TUI shows the tabbed questionnaire; RPC hosts
 *   such as T3 Code get one dialog per question.
 * - "tui": only the interactive terminal UI. In RPC/print/JSON sessions the
 *   tool is registered but removed from the active tool set, so the model
 *   never sees it and asks in prose instead.
 */
export const ASK_QUESTIONS_EXPOSURES = ['all', 'tui'] as const;
export type AskQuestionsExposure = (typeof ASK_QUESTIONS_EXPOSURES)[number];

export interface AskQuestionsConfig {
	version: 1;
	expose: AskQuestionsExposure;
}

export function defaultAskQuestionsConfig(): AskQuestionsConfig {
	return { version: 1, expose: 'all' };
}

/** Default settings path: `<agent dir>/pi-qol/ask-questions.json`. */
export function defaultAskQuestionsConfigPath(): string {
	return join(getAgentDir(), 'pi-qol', 'ask-questions.json');
}

export type AskQuestionsConfigLoad =
	| { status: 'missing' | 'ok'; config: AskQuestionsConfig; error?: undefined }
	| { status: 'invalid'; config: AskQuestionsConfig; error: string };

/**
 * Synchronous read for extension load. Missing or malformed files fall back to
 * the defaults so a bad settings file never breaks session startup.
 */
export function loadAskQuestionsConfigSync(path: string): AskQuestionsConfigLoad {
	let content: string;
	try {
		content = readFileSync(path, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return { status: 'missing', config: defaultAskQuestionsConfig() };
		}
		return { status: 'invalid', config: defaultAskQuestionsConfig(), error: `cannot read ${path}: ${errorMessage(error)}` };
	}
	try {
		const parsed: unknown = JSON.parse(content);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new Error('the file must contain a JSON object.');
		}
		const input = parsed as Record<string, unknown>;
		if (input.version !== undefined && input.version !== 1) {
			throw new Error(`unsupported version ${JSON.stringify(input.version)}; expected 1.`);
		}
		const expose: unknown = input.expose === undefined ? 'all' : input.expose;
		if (typeof expose !== 'string' || !ASK_QUESTIONS_EXPOSURES.includes(expose as AskQuestionsExposure)) {
			throw new Error(`"expose" must be one of ${ASK_QUESTIONS_EXPOSURES.join(', ')}.`);
		}
		return { status: 'ok', config: { version: 1, expose: expose as AskQuestionsExposure } };
	} catch (error) {
		return { status: 'invalid', config: defaultAskQuestionsConfig(), error: errorMessage(error) };
	}
}
