import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { complete, type ImageContent, type Model } from "@mariozechner/pi-ai";
import { getSettingsListTheme, isToolCallEventType } from "@mariozechner/pi-coding-agent";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	Theme,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import {
	Container,
	Input,
	Key,
	type SettingItem,
	SettingsList,
	Text,
	fuzzyFilter,
	matchesKey,
	truncateToWidth,
} from "@mariozechner/pi-tui";

// ─── Types ────────────────────────────────────────────────────

type RouteDomain = "frontend" | "logic" | "terminal";
type DecisionSource = "analyzer" | "heuristic" | "fallback";

type SubTask = {
	domain: RouteDomain;
	description: string;
	order: number;
};

type AutoModeConfig = {
	version: 2;
	enabled?: boolean;
	midTurnSwitch?: boolean;
	analysisModelKey?: string;
	frontendModelKey?: string;
	logicModelKey?: string;
	lastManualModelKey?: string;
};

type RouteDecision = {
	domain: RouteDomain;
	confidence: number;
	reason: string;
	source: DecisionSource;
	isMultiDomain?: boolean;
	subtasks?: SubTask[];
	currentPhase?: number;
	totalPhases?: number;
};

type PromptAnalysisInput = {
	prompt: string;
	images?: ImageContent[];
	previousMessage?: string;
};

type PendingAnalysis = PromptAnalysisInput & {
	decision: RouteDecision;
};

type PhaseState = {
	subtasks: SubTask[];
	currentIndex: number;
	originalPrompt: string;
	completedPhases: string[];
};

// ─── Constants ────────────────────────────────────────────────

const AUTO_PROVIDER = "auto";
const AUTO_MODEL_ID = "mode";
const AUTO_API = "auto-mode-router";
const CONFIG_PATH = join(homedir(), ".pi", "agent", "auto-mode-router.json");
const AUTO_MODE_STATE_PATH = join(homedir(), ".pi", "agent", "auto-mode-router-state.json");

const FRONTEND_KEYWORDS = [
	"ui", "ux", "design", "tasarım", "css", "tailwind", "style", "styling",
	"layout", "responsive", "component", "buton", "button", "form", "modal",
	"dialog", "sidebar", "navbar", "header", "footer", "theme", "renk", "color",
	"spacing", "animation", "animasyon", "page", "screen", "figma", "wireframe",
	"a11y", "accessibility", "glassmorphism", "neubrutalism", "claymorphism",
	"frontend", "görsel", "arayüz", "sayfa", "şablon", "template", "icon",
	"ikon", "font", "tipografi", "typography", "gradient", "shadow", "gölge",
	"border", "padding", "margin", "grid", "flex", "flexbox",
];

const LOGIC_KEYWORDS = [
	"logic", "mantık", "backend", "api", "endpoint", "server", "database",
	"db", "query", "migration", "auth", "permission", "validation", "schema",
	"bug", "fix", "hata", "debug", "test", "unit test", "integration",
	"algorithm", "refactor", "performance", "cache", "state", "zustand",
	"redux", "reducer", "service", "controller", "worker", "queue", "cron",
	"serialization", "parsing", "parser", "types", "type error", "compile",
	"fonksiyon", "function", "sınıf", "class", "döngü", "loop", "koşul",
	"condition", "hata ayıklama", "optimizasyon", "veritabanı", "sorgu",
];

// ─── Config helpers ───────────────────────────────────────────

function defaultConfig(): AutoModeConfig {
	return { version: 2, enabled: false, midTurnSwitch: true };
}

function loadConfig(): AutoModeConfig {
	if (!existsSync(CONFIG_PATH)) return defaultConfig();

	try {
		const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Partial<AutoModeConfig>;
		return {
			version: 2,
			enabled: parsed.enabled === true,
			midTurnSwitch: parsed.midTurnSwitch !== false,
			analysisModelKey: parsed.analysisModelKey,
			frontendModelKey: parsed.frontendModelKey,
			logicModelKey: parsed.logicModelKey,
			lastManualModelKey: parsed.lastManualModelKey,
		};
	} catch (error) {
		console.error(`[auto-mode-router] Config load failed: ${error}`);
		return defaultConfig();
	}
}

function saveConfig(config: AutoModeConfig): void {
	mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
	writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

function saveAutoModeState(enabled: boolean, label?: string): void {
	mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
	writeFileSync(
		AUTO_MODE_STATE_PATH,
		`${JSON.stringify({ enabled, label: enabled ? (label ?? "auto:armed") : "auto:off" }, null, 2)}\n`,
		"utf-8",
	);
}

// ─── Model helpers ────────────────────────────────────────────

function toModelKey(model: Pick<Model<any>, "provider" | "id">): string {
	return `${model.provider}::${model.id}`;
}

function parseModelKey(key?: string): { provider: string; id: string } | undefined {
	if (!key) return undefined;
	const separator = key.indexOf("::");
	if (separator === -1) return undefined;
	return {
		provider: key.slice(0, separator),
		id: key.slice(separator + 2),
	};
}

function findModel(ctx: ExtensionContext, key?: string): Model<any> | undefined {
	const parsed = parseModelKey(key);
	if (!parsed) return undefined;
	return ctx.modelRegistry.find(parsed.provider, parsed.id);
}

function isAutoModel(model?: Pick<Model<any>, "provider" | "id">): boolean {
	return model?.provider === AUTO_PROVIDER && model.id === AUTO_MODEL_ID;
}

function sameModel(a?: Pick<Model<any>, "provider" | "id">, b?: Pick<Model<any>, "provider" | "id">): boolean {
	if (!a || !b) return false;
	return a.provider === b.provider && a.id === b.id;
}

function hasCompleteConfig(config: AutoModeConfig): boolean {
	return Boolean(config.analysisModelKey && config.frontendModelKey && config.logicModelKey);
}

function formatModel(model?: Pick<Model<any>, "provider" | "id" | "name" | "reasoning" | "input">): string {
	if (!model) return "not set";
	const badges: string[] = [];
	if (model.reasoning) badges.push("reasoning");
	if (model.input.includes("image")) badges.push("image");
	const badgeText = badges.length > 0 ? ` [${badges.join(", ")}]` : "";
	const suffix = model.name && model.name !== model.id ? ` — ${model.name}` : "";
	return `${model.provider}/${model.id}${badgeText}${suffix}`;
}

function getSelectableModels(ctx: ExtensionContext): Model<any>[] {
	return ctx.modelRegistry
		.getAvailable()
		.filter((model) => !isAutoModel(model) && model.input.includes("text"))
		.sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
}

function getFallbackManualModel(ctx: ExtensionContext, config: AutoModeConfig): Model<any> | undefined {
	return (
		findModel(ctx, config.lastManualModelKey) ||
		findModel(ctx, config.logicModelKey) ||
		findModel(ctx, config.frontendModelKey) ||
		getSelectableModels(ctx)[0]
	);
}

// ─── Keyword / heuristic helpers ──────────────────────────────

function keywordMatches(haystack: string, word: string): boolean {
	const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
	const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}($|[^\\p{L}\\p{N}_])`, "iu");
	return pattern.test(haystack);
}

function countMatches(haystack: string, words: string[]): number {
	let score = 0;
	for (const word of words) {
		if (keywordMatches(haystack, word)) score += 1;
	}
	return score;
}

function containsImageReference(prompt: string): boolean {
	const text = prompt.trim();
	if (!text) return false;
	const imageExt = /(\.(png|jpe?g|webp|gif|bmp|svg))(\?.*)?$/i;
	const windowsPath = /[a-zA-Z]:\\[^\n\r\t"']+\.(png|jpe?g|webp|gif|bmp|svg)(\?.*)?/i;
	const unixPath = /(?:^|\s)(?:~?\/|\.\.\/|\.\/)[^\n\r\t"']+\.(png|jpe?g|webp|gif|bmp|svg)(\?.*)?/i;
	const urlPath = /https?:\/\/[^\s"']+\.(png|jpe?g|webp|gif|bmp|svg)(\?.*)?/i;
	return imageExt.test(text) || windowsPath.test(text) || unixPath.test(text) || urlPath.test(text);
}

function hasImageSignal(input: PromptAnalysisInput): boolean {
	return (input.images?.length ?? 0) > 0 || containsImageReference(input.prompt);
}

function isLikelyTerminalOnlyPrompt(prompt: string, imageCount: number): boolean {
	if (imageCount > 0) return false;
	const text = prompt.toLowerCase().trim();
	const rawCommandPattern = /^(?:!{1,2}\s*)?(git|npm|pnpm|yarn|npx|node|python|pip|docker|kubectl|ls|pwd|cd|mkdir|rm|mv|cp|cat|grep|find|chmod|curl|wget)\b/;
	const explicitTerminalPattern = /\b(git status|git commit|run this command|execute this command|just run the command|only run this command)\b/;
	const combinedTaskPattern = /[,;]\s*|\b(and|also|then|after that|but also|and then|and also)\b/;
	if (!(rawCommandPattern.test(text) || explicitTerminalPattern.test(text))) return false;
	return !combinedTaskPattern.test(text);
}

function heuristicDecision(prompt: string, imageCount: number, previousMessage?: string): RouteDecision {
	const text = prompt.toLowerCase();
	const contextText = previousMessage ? `${previousMessage.toLowerCase()} ${text}` : text;
	
	const frontendScore = countMatches(contextText, FRONTEND_KEYWORDS) + (imageCount > 0 ? 1 : 0);
	const logicScore = countMatches(contextText, LOGIC_KEYWORDS);

	if (isLikelyTerminalOnlyPrompt(prompt, imageCount)) {
		return {
			domain: "terminal",
			confidence: 0.7,
			reason: "The request looks like a standalone terminal or git command task",
			source: "heuristic",
		};
	}

	if (frontendScore >= 2 && logicScore >= 2) {
		const primaryDomain: RouteDomain = frontendScore > logicScore ? "frontend" : "logic";
		const secondaryDomain: RouteDomain = primaryDomain === "frontend" ? "logic" : "frontend";
		return {
			domain: primaryDomain,
			confidence: 0.6,
			reason: "Both UI and logic signals were detected, so this appears to be a multi-domain task",
			source: "heuristic",
			isMultiDomain: true,
			subtasks: [
				{ domain: primaryDomain, description: `${primaryDomain} work`, order: 0 },
				{ domain: secondaryDomain, description: `${secondaryDomain} work`, order: 1 },
			],
			currentPhase: 0,
			totalPhases: 2,
		};
	}

	const domain: RouteDomain = frontendScore > logicScore ? "frontend" : "logic";
	const spread = Math.abs(frontendScore - logicScore);
	const confidence = Math.max(0.55, Math.min(0.9, 0.55 + spread * 0.08));
	return {
		domain,
		confidence,
		reason:
			domain === "frontend"
				? "UI and design signals are stronger"
				: "Logic and data-flow signals are stronger",
		source: "heuristic",
	};
}

// ─── Analyzer ─────────────────────────────────────────────────

function stripCodeFences(text: string): string {
	return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function parseAnalyzerResult(text: string): RouteDecision | undefined {
	const cleaned = stripCodeFences(text);

	try {
		const parsed = JSON.parse(cleaned) as {
			category?: string;
			confidence?: number;
			reason?: string;
			isMultiDomain?: boolean;
			subtasks?: Array<{ domain: string; description: string; order?: number }>;
		};
		const domain =
			parsed.category === "frontend"
				? "frontend"
				: parsed.category === "logic"
					? "logic"
					: parsed.category === "terminal"
						? "terminal"
						: undefined;
		if (!domain) return undefined;

		const subtasks: SubTask[] | undefined = parsed.subtasks?.map((st, idx) => ({
			domain: st.domain === "frontend" ? "frontend" : st.domain === "terminal" ? "terminal" : "logic",
			description: st.description || "",
			order: st.order ?? idx,
		}));

		return {
			domain,
			confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.7,
			reason: parsed.reason?.trim() || "Analyzer response",
			source: "analyzer",
			isMultiDomain: parsed.isMultiDomain === true || (subtasks && subtasks.length > 1),
			subtasks: subtasks && subtasks.length > 1 ? subtasks : undefined,
			currentPhase: subtasks && subtasks.length > 1 ? 0 : undefined,
			totalPhases: subtasks && subtasks.length > 1 ? subtasks.length : undefined,
		};
	} catch {
		const lowered = cleaned.toLowerCase();
		if (lowered.includes("frontend")) {
			return { domain: "frontend", confidence: 0.65, reason: cleaned, source: "analyzer" };
		}
		if (lowered.includes("logic")) {
			return { domain: "logic", confidence: 0.65, reason: cleaned, source: "analyzer" };
		}
		if (lowered.includes("terminal")) {
			return { domain: "terminal", confidence: 0.65, reason: cleaned, source: "analyzer" };
		}
	}

	return undefined;
}

function buildAnalyzerPrompt(prompt: string, imageCount: number, previousMessage?: string): string {
	const lines = [
		"You are a model-routing classifier.",
		"Your job is to analyze the user's latest prompt and determine its primary execution domain.",
		"",
		"There are three categories:",
		"- frontend: UI design, visual layout, styling, CSS, component appearance, responsive behavior, accessibility, and UX polish",
		"- logic: business logic, backend, data flow, bug fixing, algorithms, state management, tests, refactoring, performance, and integrations",
		"- terminal: only when the request is primarily about running a terminal/shell/git command or doing terminal-style inspection work",
		"",
		"IMPORTANT: If the prompt requires both frontend and logic work:",
		"- set isMultiDomain to true",
		"- list each meaningful step in subtasks",
		"- every subtask must include domain (frontend|logic) and description",
		"- choose the dominant domain as category",
		"- order subtasks in the sequence they should be executed",
		"",
		"Rules:",
		"- For mixed requests, focus on the primary outcome the user wants.",
		"- If the visual/presentational side is dominant, choose frontend.",
		"- If correctness, data, behavior, debugging, or implementation is dominant, choose logic.",
		"- Choose terminal only if the user's main intent is command execution or terminal inspection by itself.",
		"- If terminal, commit, or bash is mentioned as part of a larger implementation task, do not choose terminal.",
		"- For general software tasks outside UI work, default to logic.",
		"- Return only valid JSON. Do not write anything else.",
		"",
		"Single-domain JSON schema:",
		'{\"category\":\"frontend|logic|terminal\",\"confidence\":0.0,\"reason\":\"short explanation\",\"isMultiDomain\":false}',
		"",
		"Multi-domain JSON schema:",
		'{\"category\":\"frontend|logic\",\"confidence\":0.0,\"reason\":\"short explanation\",\"isMultiDomain\":true,\"subtasks\":[{\"domain\":\"frontend|logic\",\"description\":\"subtask description\",\"order\":0}]}',
		"",
		imageCount > 0 ? `The user attached ${imageCount} image(s).` : "The user did not attach images.",
	];

	if (previousMessage) {
		lines.push("");
		lines.push("<previous_message>");
		lines.push(previousMessage);
		lines.push("</previous_message>");
	}

	lines.push("");
	lines.push("<current_prompt>");
	lines.push(prompt);
	lines.push("</current_prompt>");

	return lines.join("\n");
}

function buildAnalyzerContent(input: PromptAnalysisInput, model: Model<any>): Array<{ type: "text"; text: string } | ImageContent> {
	const content: Array<{ type: "text"; text: string } | ImageContent> = [
		{ type: "text", text: buildAnalyzerPrompt(input.prompt, input.images?.length ?? 0, input.previousMessage) },
	];

	if (input.images?.length && model.input.includes("image")) {
		content.push(...input.images);
	}

	return content;
}

async function analyzePrompt(
	input: PromptAnalysisInput,
	ctx: ExtensionContext,
	config: AutoModeConfig,
): Promise<RouteDecision> {
	const fallback = heuristicDecision(input.prompt, input.images?.length ?? 0, input.previousMessage);
	const analyzerModel = findModel(ctx, config.analysisModelKey);
	if (!analyzerModel) return { ...fallback, source: "fallback", reason: "Analysis model not found, heuristic routing was used" };

	try {
		const apiKey = await ctx.modelRegistry.getApiKey(analyzerModel);
		if (!apiKey) {
			return { ...fallback, source: "fallback", reason: "No credentials found for the analysis model, heuristic routing was used" };
		}

		const response = await complete(
			analyzerModel,
			{
				messages: [
					{
						role: "user",
						content: buildAnalyzerContent(input, analyzerModel),
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey, reasoningEffort: "minimal" },
		);
		const text = response.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("\n")
			.trim();
		return parseAnalyzerResult(text) || fallback;
	} catch (error) {
		console.error(`[auto-mode-router] Analyzer failed: ${error}`);
		
		// Check for API key or authentication errors
		const errorMsg = String(error);
		if (errorMsg.includes("401") || errorMsg.includes("403") || errorMsg.includes("authentication") || errorMsg.includes("api key")) {
			ctx.ui.notify("Auto Mode: analysis model authentication failed. Check model settings or update them with /auto-mode config.", "warning");
		}
		
		return { ...fallback, source: "fallback", reason: "Analysis request failed, heuristic routing was used" };
	}
}

// ─── UI helpers ───────────────────────────────────────────────

function describeConfig(ctx: ExtensionContext, config: AutoModeConfig, autoEnabled: boolean, lastRoute?: RouteDecision, phaseState?: PhaseState): string {
	const analysis = formatModel(findModel(ctx, config.analysisModelKey));
	const frontend = formatModel(findModel(ctx, config.frontendModelKey));
	const logic = formatModel(findModel(ctx, config.logicModelKey));
	const manual = formatModel(findModel(ctx, config.lastManualModelKey));
	const mode = autoEnabled ? "On" : "Off";
	const midTurn = config.midTurnSwitch !== false ? "On" : "Off";
	const last = lastRoute ? `${lastRoute.domain} (${Math.round(lastRoute.confidence * 100)}%)` : "none";
	const multi = lastRoute?.isMultiDomain ? "Yes" : "No";

	const lines = [
		`Auto Mode: ${mode}`,
		`Mid-turn switching: ${midTurn}`,
		`Analysis model: ${analysis}`,
		`Frontend model: ${frontend}`,
		`Logic model: ${logic}`,
		`Terminal routing: uses the analysis model`,
		`Last manual model: ${manual}`,
		`Last decision: ${last}`,
		`Multi-domain: ${multi}`,
	];

	if (phaseState && phaseState.subtasks.length > 0) {
		lines.push(`Active phase: ${phaseState.currentIndex + 1}/${phaseState.subtasks.length}`);
		for (let i = 0; i < phaseState.subtasks.length; i++) {
			const st = phaseState.subtasks[i];
			const status = i < phaseState.currentIndex ? "✅" : i === phaseState.currentIndex ? "🔄" : "⏳";
			lines.push(`  ${status} Phase ${i + 1}: [${st.domain}] ${st.description}`);
		}
	}

	lines.push(`Config file: ${CONFIG_PATH}`);
	return lines.join("\n");
}

function updateStatus(ctx: ExtensionContext, autoEnabled: boolean, lastRoute?: RouteDecision, phaseState?: PhaseState): void {
	if (!autoEnabled) {
		ctx.ui.setStatus("auto-mode", undefined);
		saveAutoModeState(false, "auto:off");
		return;
	}

	let label: string;
	if (phaseState && phaseState.subtasks.length > 1) {
		const current = phaseState.subtasks[phaseState.currentIndex];
		label = `auto:${current.domain} [${phaseState.currentIndex + 1}/${phaseState.subtasks.length}]`;
	} else if (lastRoute) {
		label = `auto:${lastRoute.domain}`;
		if (lastRoute.isMultiDomain) {
			label += " (multi)";
		}
	} else {
		label = "auto:armed";
	}

	ctx.ui.setStatus("auto-mode", ctx.ui.theme.fg("accent", label));
	saveAutoModeState(true, label);
}

// ─── Model picker ─────────────────────────────────────────────

function getDefaultModelKey(models: Model<any>[], index: number): string | undefined {
	const model = models[Math.min(index, models.length - 1)];
	return model ? toModelKey(model) : undefined;
}

function buildModelValueMap(models: Model<any>[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const model of models) {
		map.set(formatModel(model), toModelKey(model));
	}
	return map;
}

function createModelPicker(
	theme: Theme,
	models: Model<any>[],
	currentValue: string,
	done: (selectedValue?: string) => void,
) {
	type PickerItem = {
		value: string;
		label: string;
		description: string;
		searchText: string;
	};

	const items: PickerItem[] = models.map((model) => {
		const label = `${model.provider}/${model.id}`;
		const description = [model.name && model.name !== model.id ? model.name : undefined, model.reasoning ? "reasoning" : undefined]
			.filter(Boolean)
			.join(" • ");
		return {
			value: formatModel(model),
			label,
			description,
			searchText: `${label} ${description} ${model.name ?? ""}`.trim(),
		};
	});

	const searchInput = new Input();
	let filteredItems = items;
	let selectedIndex = Math.max(
		0,
		items.findIndex((item) => item.value === currentValue),
	);
	const maxVisible = Math.min(Math.max(items.length, 8), 14);

	searchInput.setValue("");
	searchInput.onEscape = () => done(undefined);

	const clampSelection = () => {
		selectedIndex = Math.max(0, Math.min(selectedIndex, Math.max(filteredItems.length - 1, 0)));
	};

	const refreshFilter = () => {
		const query = searchInput.getValue().trim();
		filteredItems = query ? fuzzyFilter(items, query, (item) => item.searchText) : items;
		if (filteredItems.length === 0) {
			selectedIndex = 0;
			return;
		}
		const exactIndex = filteredItems.findIndex((item) => item.value === currentValue);
		if (query.length > 0 && selectedIndex >= filteredItems.length) {
			selectedIndex = 0;
		} else if (query.length === 0 && exactIndex >= 0) {
			selectedIndex = exactIndex;
		}
		clampSelection();
	};

	refreshFilter();

	return {
		get focused() {
			return searchInput.focused;
		},
		set focused(value: boolean) {
			searchInput.focused = value;
		},
		render(width: number): string[] {
			const lines: string[] = [];
			lines.push(truncateToWidth(theme.fg("accent", theme.bold("Model Picker")), width));
			lines.push(truncateToWidth(theme.fg("muted", "Type to filter • ↑↓ navigate • Enter select • Esc back"), width));
			lines.push("");
			lines.push(truncateToWidth(theme.fg("dim", "Ara:"), width));
			lines.push(...searchInput.render(width).map((line) => truncateToWidth(line, width)));
			lines.push("");

			if (filteredItems.length === 0) {
				lines.push(truncateToWidth(theme.fg("warning", "No matching model found."), width));
				return lines;
			}

			const startIndex = Math.max(
				0,
				Math.min(selectedIndex - Math.floor(maxVisible / 2), Math.max(filteredItems.length - maxVisible, 0)),
			);
			const endIndex = Math.min(startIndex + maxVisible, filteredItems.length);

			for (let i = startIndex; i < endIndex; i++) {
				const item = filteredItems[i];
				const selected = i === selectedIndex;
				const prefix = selected ? theme.fg("accent", "> ") : "  ";
				const label = selected ? theme.fg("accent", item.label) : theme.fg("text", item.label);
				lines.push(truncateToWidth(`${prefix}${label}`, width));
				if (item.description) {
					lines.push(truncateToWidth(`   ${theme.fg("muted", item.description)}`, width));
				}
			}

			if (filteredItems.length > maxVisible) {
				lines.push("");
				lines.push(
					truncateToWidth(theme.fg("dim", `(${selectedIndex + 1}/${filteredItems.length})`), width),
				);
			}

			return lines;
		},
		invalidate() {
			searchInput.invalidate();
		},
		handleInput(data: string) {
			if (matchesKey(data, Key.escape)) {
				done(undefined);
				return;
			}
			if (matchesKey(data, Key.enter)) {
				done(filteredItems[selectedIndex]?.value);
				return;
			}
			if (matchesKey(data, Key.up)) {
				if (filteredItems.length > 0) selectedIndex = selectedIndex === 0 ? filteredItems.length - 1 : selectedIndex - 1;
				return;
			}
			if (matchesKey(data, Key.down)) {
				if (filteredItems.length > 0) selectedIndex = selectedIndex === filteredItems.length - 1 ? 0 : selectedIndex + 1;
				return;
			}
			searchInput.handleInput(data);
			refreshFilter();
		},
	};
}

// ─── Configuration dialog ─────────────────────────────────────

async function configureAutoMode(
	ctx: ExtensionContext,
	config: AutoModeConfig,
	options?: { forceDialog?: boolean },
): Promise<boolean> {
	const models = getSelectableModels(ctx);
	if (models.length === 0) {
		ctx.ui.notify("No selectable model was found for Auto Mode. Run /login or configure your API keys first.", "warning");
		return false;
	}

	if (!ctx.hasUI) {
		return hasCompleteConfig(config);
	}

	const draft: AutoModeConfig = {
		...config,
		version: 2,
		analysisModelKey: config.analysisModelKey ?? getDefaultModelKey(models, 0),
		frontendModelKey: config.frontendModelKey ?? getDefaultModelKey(models, Math.min(1, models.length - 1)),
		logicModelKey: config.logicModelKey ?? getDefaultModelKey(models, Math.min(2, models.length - 1)),
	};

	if (!options?.forceDialog && hasCompleteConfig(config)) {
		return true;
	}

	const valueMap = buildModelValueMap(models);
	const saved = await ctx.ui.custom<boolean>(
		(tui, theme, _kb, done) => {
			const items: SettingItem[] = [
				{
					id: "analysis",
					label: "Analysis model",
					description: "The model used to classify each prompt first. It is also used for terminal-only routing.",
					currentValue: formatModel(findModel(ctx, draft.analysisModelKey) || models[0]),
					submenu: (currentValue, submenuDone) => createModelPicker(theme, models, currentValue, submenuDone),
				},
				{
					id: "frontend",
					label: "Frontend model",
					description: "Used for UI, design, CSS, visual presentation, and UX-focused requests.",
					currentValue: formatModel(findModel(ctx, draft.frontendModelKey) || models[0]),
					submenu: (currentValue, submenuDone) => createModelPicker(theme, models, currentValue, submenuDone),
				},
				{
					id: "logic",
					label: "Logic model",
					description: "Used for logic, backend, debugging, data flow, implementation, and testing tasks.",
					currentValue: formatModel(findModel(ctx, draft.logicModelKey) || models[0]),
					submenu: (currentValue, submenuDone) => createModelPicker(theme, models, currentValue, submenuDone),
				},
				{
					id: "midturn",
					label: "Mid-turn switching",
					description: "Allows the agent to switch models during execution by using the switch_domain tool.",
					currentValue: draft.midTurnSwitch !== false ? "On" : "Off",
					values: ["On", "Off"],
				},
			];

			const container = new Container();
			container.addChild(new Text(theme.fg("accent", theme.bold("Auto Mode Configuration")), 1, 1));
			container.addChild(
				new Text(
					theme.fg("muted", "Press Enter or Space to open the searchable model picker. Type to filter, then press Enter to select."),
					1,
					0,
				),
			);

			const settingsList = new SettingsList(
				items,
				Math.min(items.length + 3, 12),
				getSettingsListTheme(),
				(id, newValue) => {
					const key = valueMap.get(newValue);
					if (id === "analysis" && key) draft.analysisModelKey = key;
					if (id === "frontend" && key) draft.frontendModelKey = key;
					if (id === "logic" && key) draft.logicModelKey = key;
					if (id === "midturn") draft.midTurnSwitch = newValue === "On";
				},
				() => done(false),
			);

			container.addChild(settingsList);
			container.addChild(
				new Text(
					theme.fg("dim", "Ctrl+S save • Esc cancel"),
					1,
					1,
				),
			);

			return {
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					if (matchesKey(data, Key.ctrl("s"))) {
						done(true);
						return;
					}
					if (matchesKey(data, Key.escape)) {
						done(false);
						return;
					}
					settingsList.handleInput?.(data);
					tui.requestRender();
				},
			};
		},
		{ overlay: true },
	);

	if (!saved) return false;
	config.analysisModelKey = draft.analysisModelKey;
	config.frontendModelKey = draft.frontendModelKey;
	config.logicModelKey = draft.logicModelKey;
	config.midTurnSwitch = draft.midTurnSwitch;
	saveConfig(config);
	ctx.ui.notify("Auto Mode configuration saved.", "info");
	return true;
}

// ─── Main extension ───────────────────────────────────────────

export default function autoModeRouter(pi: ExtensionAPI) {
	let config = loadConfig();
	let autoEnabled = false;
	let internalModelSwitchDepth = 0;
	let lastRoute: RouteDecision | undefined;
	let pendingAnalysis: PendingAnalysis | undefined;
	let phaseState: PhaseState | undefined;
	let activeDomain: RouteDomain | undefined;
	let midTurnSwitchCount = 0;
	const MAX_MID_TURN_SWITCHES = 6;

	// ─── Internal model switch wrapper ────────────────────────

	const withInternalModelSwitch = async (fn: () => Promise<boolean>): Promise<boolean> => {
		internalModelSwitchDepth += 1;
		try {
			return await fn();
		} finally {
			internalModelSwitchDepth -= 1;
		}
	};

	const switchModel = async (model: Model<any>): Promise<boolean> => withInternalModelSwitch(() => pi.setModel(model));

	const rememberManualModel = (ctx: ExtensionContext, modelOverride?: Pick<Model<any>, "provider" | "id">): void => {
		const model = modelOverride ?? ctx.model;
		if (model && !isAutoModel(model)) {
			config.lastManualModelKey = toModelKey(model);
			saveConfig(config);
		}
	};

	// ─── Feedback helpers ─────────────────────────────────────

	const beginAnalysisFeedback = (ctx: ExtensionContext) => {
		ctx.ui.setStatus("auto-mode-phase", ctx.ui.theme.fg("muted", "analyzing..."));
		ctx.ui.setWorkingMessage("Analyzing...");
		ctx.ui.notify("Analyzing...", "info");
	};

	const endAnalysisFeedback = (ctx: ExtensionContext) => {
		ctx.ui.setStatus("auto-mode-phase", undefined);
		ctx.ui.setWorkingMessage();
	};

	const matchesPendingAnalysis = (input: PromptAnalysisInput, pending?: PendingAnalysis) => {
		if (!pending) return false;
		return pending.prompt === input.prompt && 
		       (pending.images?.length ?? 0) === (input.images?.length ?? 0) &&
		       pending.previousMessage === input.previousMessage;
	};

	// ─── Route to model ───────────────────────────────────────

	const routeToTargetModel = async (
		ctx: ExtensionContext,
		decision: RouteDecision,
		options?: { requireImageInput?: boolean },
	): Promise<Model<any> | undefined> => {
		const requireImageInput = options?.requireImageInput === true;
		const canUse = (model?: Model<any>) => {
			if (!model) return false;
			if (!model.input.includes("text")) return false;
			if (requireImageInput && !model.input.includes("image")) return false;
			return true;
		};

		const addCandidate = (list: Model<any>[], model?: Model<any>) => {
			if (!model) return;
			if (!list.some((item) => sameModel(item, model))) {
				list.push(model);
			}
		};

		const candidates: Model<any>[] = [];
		const available = getSelectableModels(ctx);
		const analysis = findModel(ctx, config.analysisModelKey);
		const frontend = findModel(ctx, config.frontendModelKey);
		const logic = findModel(ctx, config.logicModelKey);
		const terminal = findModel(ctx, config.analysisModelKey);
		const fallback = getFallbackManualModel(ctx, config);

		if (decision.domain === "terminal") {
			addCandidate(candidates, terminal);
			addCandidate(candidates, analysis);
			addCandidate(candidates, fallback);
		} else if (decision.domain === "frontend") {
			addCandidate(candidates, frontend);
			addCandidate(candidates, logic);
			addCandidate(candidates, analysis);
			addCandidate(candidates, fallback);
		} else {
			addCandidate(candidates, logic);
			addCandidate(candidates, frontend);
			addCandidate(candidates, analysis);
			addCandidate(candidates, fallback);
		}

		const availableCandidates = candidates
			.map((candidate) => available.find((model) => sameModel(model, candidate)))
			.filter((model): model is Model<any> => Boolean(model));

		for (const candidate of availableCandidates) {
			if (canUse(candidate)) return candidate;
		}

		if (requireImageInput) {
			return undefined;
		}

		return availableCandidates[0];
	};

	// ─── Domain-specific model switch ─────────────────────────

	const switchToDomain = async (ctx: ExtensionContext, domain: RouteDomain): Promise<boolean> => {
		if (activeDomain === domain) return true;

		const decision: RouteDecision = {
			domain,
			confidence: 0.9,
			reason: `Mid-turn switch: moving to the ${domain} model`,
			source: "heuristic",
		};

		const targetModel = await routeToTargetModel(ctx, decision);
		if (!targetModel) return false;

		if (sameModel(ctx.model, targetModel)) {
			activeDomain = domain;
			return true;
		}

		const switched = await switchModel(targetModel);
		if (switched) {
			activeDomain = domain;
			updateStatus(ctx, autoEnabled, lastRoute, phaseState);
		}
		return switched;
	};

	// ─── Phase management ─────────────────────────────────────

	const advancePhase = async (ctx: ExtensionContext): Promise<boolean> => {
		if (!phaseState || phaseState.currentIndex >= phaseState.subtasks.length - 1) {
			return false;
		}

		phaseState.completedPhases.push(
			`Phase ${phaseState.currentIndex + 1} (${phaseState.subtasks[phaseState.currentIndex].domain}) completed`,
		);

		phaseState.currentIndex += 1;
		const nextPhase = phaseState.subtasks[phaseState.currentIndex];

		ctx.ui.notify(
			`📋 Phase ${phaseState.currentIndex + 1}/${phaseState.subtasks.length}: [${nextPhase.domain}] ${nextPhase.description}`,
			"info",
		);

		const switched = await switchToDomain(ctx, nextPhase.domain);
		updateStatus(ctx, autoEnabled, lastRoute, phaseState);
		return switched;
	};

	// ─── Activate / deactivate ────────────────────────────────

	const activateAutoMode = async (ctx: ExtensionContext): Promise<boolean> => {
		const configured = await configureAutoMode(ctx, config, {
			forceDialog: false,
		});
		if (!configured) return false;

		rememberManualModel(ctx);
		autoEnabled = true;
		config.enabled = true;
		saveConfig(config);
		lastRoute = undefined;
		phaseState = undefined;
		activeDomain = undefined;
		updateStatus(ctx, autoEnabled, lastRoute, phaseState);
		ctx.ui.notify("Auto Mode enabled. Each prompt will be analyzed and routed automatically.", "info");
		return true;
	};

	const disableAutoMode = async (ctx: ExtensionContext, notify = true): Promise<void> => {
		autoEnabled = false;
		config.enabled = false;
		saveConfig(config);
		pendingAnalysis = undefined;
		lastRoute = undefined;
		phaseState = undefined;
		activeDomain = undefined;
		midTurnSwitchCount = 0;
		updateStatus(ctx, autoEnabled, lastRoute, phaseState);
		endAnalysisFeedback(ctx);

		if (isAutoModel(ctx.model)) {
			const fallback = getFallbackManualModel(ctx, config);
			if (fallback) {
				await switchModel(fallback);
				rememberManualModel(ctx, fallback);
			}
		}

		if (notify) {
			ctx.ui.notify("Auto Mode disabled. Returned to manual model selection.", "info");
		}
	};

	// ─── Status / toggle / command ────────────────────────────

	const showStatus = (ctx: ExtensionContext): void => {
		ctx.ui.notify(describeConfig(ctx, config, autoEnabled, lastRoute, phaseState), "info");
	};

	const toggleAutoMode = async (ctx: ExtensionContext): Promise<void> => {
		if (autoEnabled) {
			await disableAutoMode(ctx);
			return;
		}
		await activateAutoMode(ctx);
	};

	const openCommandMenu = async (ctx: ExtensionCommandContext): Promise<void> => {
		const choice = await ctx.ui.select("Auto Mode", [
			"Enable",
			"Configure / change models",
			"Show status",
			"Disable",
		]);

		if (choice === "Enable") {
			await activateAutoMode(ctx);
			return;
		}
		if (choice === "Configure / change models") {
			await configureAutoMode(ctx, config, { forceDialog: true });
			updateStatus(ctx, autoEnabled, lastRoute, phaseState);
			return;
		}
		if (choice === "Show status") {
			showStatus(ctx);
			return;
		}
		if (choice === "Disable") {
			await disableAutoMode(ctx);
		}
	};

	// ─── Register auto provider ───────────────────────────────

	const registerAutoProvider = () => {
		pi.registerProvider(AUTO_PROVIDER, {
			baseUrl: "http://127.0.0.1/auto-mode-router",
			apiKey: "AUTO_MODE_LOCAL",
			api: AUTO_API,
			streamSimple: () => {
				throw new Error("Auto Mode routing did not complete. Check the configuration with /auto-mode.");
			},
			models: [
				{
					id: AUTO_MODEL_ID,
					name: "Auto Mode",
					reasoning: true,
					input: ["text", "image"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 1_000_000,
					maxTokens: 32_000,
				},
			],
		});
	};

	registerAutoProvider();

	// ─── Register switch_domain tool ──────────────────────────

	pi.registerTool({
		name: "switch_domain",
		label: "Switch Domain",
		description: [
			"Switch the active work domain during a task.",
			"Use 'frontend' when moving from logic/backend work to UI, design, or CSS work.",
			"Use 'logic' when moving from frontend/UI work to backend, data, state, or implementation work.",
			"This automatically switches to the most appropriate model for the selected domain.",
			"Only use it when a real domain change is needed.",
		].join(" "),
		promptSnippet: "Switch active domain (frontend/logic) mid-task to use the best model for each part",
		promptGuidelines: [
			"If a task includes both design work (UI/CSS/styling) and implementation work (logic/backend/API), switch domains when one part is complete and the next domain becomes primary.",
			"Stay in the frontend domain while working on design files such as CSS, HTML, or component styling.",
			"Stay in the logic domain while working on APIs, services, utilities, tests, or implementation logic.",
			"Do not call this tool if you are staying within the same domain.",
			"Provide a short reason when switching domains.",
		],
		parameters: Type.Object({
			domain: StringEnum(["frontend", "logic"] as const, { description: "Target domain: frontend or logic" }),
			reason: Type.String({ description: "Short reason for switching domains" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!autoEnabled) {
				return {
					content: [{ type: "text", text: "Auto Mode is not enabled." }],
					details: { switched: false },
				};
			}

			if (midTurnSwitchCount >= MAX_MID_TURN_SWITCHES) {
				return {
					content: [{ type: "text", text: `Maximum switch count reached (${MAX_MID_TURN_SWITCHES}).` }],
					details: { switched: false, reason: "max_switches_reached" },
				};
			}

			const targetDomain = params.domain as RouteDomain;
			if (activeDomain === targetDomain) {
				return {
					content: [],
					details: { switched: false, currentDomain: targetDomain, silent: true },
				};
			}

			const previousModel = ctx.model;
			const switched = await switchToDomain(ctx, targetDomain);
			midTurnSwitchCount += 1;

			if (switched) {
				// Advance phase when this is a multi-domain task
				if (phaseState) {
					const nextPhaseIdx = phaseState.subtasks.findIndex(
						(st, idx) => idx > phaseState!.currentIndex && st.domain === targetDomain,
					);
					if (nextPhaseIdx >= 0) {
						phaseState.completedPhases.push(
							`Phase ${phaseState.currentIndex + 1} (${phaseState.subtasks[phaseState.currentIndex].domain}) completed`,
						);
						phaseState.currentIndex = nextPhaseIdx;
						updateStatus(ctx, autoEnabled, lastRoute, phaseState);
					}
				}

				const targetModel = ctx.model;
				const prevModelName = previousModel ? previousModel.id : "belirsiz";
				const newModelName = targetModel ? targetModel.id : "belirsiz";
				
				return {
					content: [{
						type: "text",
						text: `switch domain ${prevModelName} → ${newModelName}`,
					}],
					details: {
						switched: true,
						previousModel: prevModelName,
						newModel: newModelName,
						domain: targetDomain,
					},
				};
			}

			return {
				content: [{ type: "text", text: "Domain switch failed." }],
				details: { switched: false, targetDomain, reason: "switch_failed" },
			};
		},
	});

	// ─── Commands ─────────────────────────────────────────────

	const handleCommand = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		const action = args.trim().toLowerCase();
		if (!action) {
			await openCommandMenu(ctx);
			return;
		}

		if (["on", "enable", "start"].includes(action)) {
			await activateAutoMode(ctx);
			return;
		}
		if (["off", "disable", "stop", "kapat"].includes(action)) {
			await disableAutoMode(ctx);
			return;
		}
		if (["status", "show", "durum"].includes(action)) {
			showStatus(ctx);
			return;
		}
		if (["config", "configure", "setup", "ayar"].includes(action)) {
			await configureAutoMode(ctx, config, { forceDialog: true });
			updateStatus(ctx, autoEnabled, lastRoute, phaseState);
			return;
		}

		ctx.ui.notify("Usage: /auto-mode [on|off|status|config]", "warning");
	};

	pi.registerCommand("auto-mode", {
		description: "Enable, disable, or configure Auto Mode",
		handler: handleCommand,
	});

	pi.registerCommand("auto", {
		description: "Short command for Auto Mode",
		handler: handleCommand,
	});

	pi.registerShortcut(Key.alt("a"), {
		description: "Toggle Auto Mode",
		handler: async (ctx) => toggleAutoMode(ctx),
	});

	// ─── Input event: analyze prompt ──────────────────────────

	pi.on("input", async (event, ctx) => {
		if (!autoEnabled || !hasCompleteConfig(config)) return { action: "continue" };
		if (event.source === "extension") return { action: "continue" };
		if (event.text.trim().length === 0) return { action: "continue" };

		// Capture the last two messages for better context
		let previousMessage: string | undefined;
		if (ctx.messages && ctx.messages.length > 0) {
			const messagesToInclude = Math.min(2, ctx.messages.length);
			const recentMessages = ctx.messages.slice(-messagesToInclude);
			const contextParts: string[] = [];
			
			for (const msg of recentMessages) {
				if (msg.content && Array.isArray(msg.content)) {
					const text = msg.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map(c => c.text)
						.join("\n")
						.trim();
					if (text) {
						contextParts.push(`[${msg.role}]: ${text}`);
					}
				}
			}
			
			if (contextParts.length > 0) {
				previousMessage = contextParts.join("\n\n");
			}
		}

		const input: PromptAnalysisInput = {
			prompt: event.text,
			images: event.images,
			previousMessage,
		};

		pendingAnalysis = undefined;
		phaseState = undefined;
		midTurnSwitchCount = 0;

		beginAnalysisFeedback(ctx);
		try {
			const decision = await analyzePrompt(input, ctx, config);
			const inputHasImage = hasImageSignal(input);
			const targetModel = await routeToTargetModel(ctx, decision, {
				requireImageInput: inputHasImage,
			});
			if (!targetModel) {
				const hasImage = inputHasImage;
				await disableAutoMode(ctx, false);
				ctx.ui.notify(
					hasImage
						? "An image was detected, but no suitable image-capable target model was found. Auto Mode was disabled and control returned to manual mode."
						: "No target model was found for Auto Mode. Auto Mode was disabled and control returned to manual mode.",
					"error",
				);
				return { action: "continue" };
			}

			const switched = await switchModel(targetModel);
			if (!switched) {
				await disableAutoMode(ctx, false);
				ctx.ui.notify(`Could not switch to target model: ${formatModel(targetModel)}`, "error");
				return { action: "continue" };
			}

			lastRoute = decision;
			activeDomain = decision.domain;

			// Initialize phases for a multi-domain task
			if (decision.isMultiDomain && decision.subtasks && decision.subtasks.length > 1) {
				phaseState = {
					subtasks: decision.subtasks.sort((a, b) => a.order - b.order),
					currentIndex: 0,
					originalPrompt: event.text,
					completedPhases: [],
				};
				ctx.ui.notify(
					`📋 Multi-domain task detected: ${decision.subtasks.length} phases\n` +
					decision.subtasks.map((st, i) => `  ${i + 1}. [${st.domain}] ${st.description}`).join("\n"),
					"info",
				);
			}

			updateStatus(ctx, autoEnabled, lastRoute, phaseState);
			ctx.ui.notify(`Auto Mode: ${targetModel.id}${decision.isMultiDomain ? " (multi-domain)" : ""}`, "info");
			pendingAnalysis = { ...input, decision };
		} finally {
			endAnalysisFeedback(ctx);
		}

		return { action: "continue" };
	});

	// ─── Session start ────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig();
		pendingAnalysis = undefined;
		phaseState = undefined;
		activeDomain = undefined;
		midTurnSwitchCount = 0;
		autoEnabled = config.enabled === true;
		const restoredAutoModel = isAutoModel(ctx.model);

		if (restoredAutoModel) {
			const fallback = getFallbackManualModel(ctx, config);
			if (fallback) {
				await switchModel(fallback);
				rememberManualModel(ctx, fallback);
			}
		} else {
			rememberManualModel(ctx);
		}

		if (autoEnabled && !hasCompleteConfig(config)) {
			ctx.ui.notify("Auto Mode is selected but not configured. Returning to manual mode.", "warning");
			await disableAutoMode(ctx, false);
			return;
		}

		updateStatus(ctx, autoEnabled, lastRoute, phaseState);
	});

	// ─── Model select ─────────────────────────────────────────

	pi.on("model_select", async (event, ctx) => {
		if (internalModelSwitchDepth > 0) return;

		if (isAutoModel(event.model)) {
			if (event.source === "restore" && config.enabled !== true) {
				const fallback = event.previousModel || getFallbackManualModel(ctx, config);
				if (fallback) {
					await switchModel(fallback);
					rememberManualModel(ctx, fallback);
				}
				autoEnabled = false;
				updateStatus(ctx, autoEnabled, lastRoute, phaseState);
				return;
			}

			if (!hasCompleteConfig(config)) {
				const configured = await configureAutoMode(ctx, config, { forceDialog: ctx.hasUI });
				if (!configured) {
					autoEnabled = false;
					config.enabled = false;
					saveConfig(config);
					updateStatus(ctx, autoEnabled, lastRoute, phaseState);
					const fallback = event.previousModel || getFallbackManualModel(ctx, config);
					if (fallback) await switchModel(fallback);
					ctx.ui.notify("Auto Mode setup was cancelled.", "warning");
					return;
				}
			}

			autoEnabled = true;
			config.enabled = true;
			saveConfig(config);
			lastRoute = undefined;
			phaseState = undefined;
			activeDomain = undefined;
			updateStatus(ctx, autoEnabled, lastRoute, phaseState);

			const fallback = event.previousModel || getFallbackManualModel(ctx, config);
			if (fallback) {
				await switchModel(fallback);
				rememberManualModel(ctx, fallback);
			}

			if (event.source !== "restore") {
				ctx.ui.notify("Auto Mode enabled. Prompts will be analyzed and routed automatically.", "info");
			}
			return;
		}

		pendingAnalysis = undefined;
		rememberManualModel(ctx, event.model);

		if (autoEnabled || config.enabled) {
			autoEnabled = false;
			config.enabled = false;
			saveConfig(config);
			lastRoute = undefined;
			phaseState = undefined;
			activeDomain = undefined;
			updateStatus(ctx, autoEnabled, lastRoute, phaseState);
			ctx.ui.notify("A manual model was selected, so Auto Mode was disabled.", "info");
		}
	});

	// ─── Before agent start: system prompt injection ──────────

	pi.on("before_agent_start", async (event, ctx) => {
		if (!autoEnabled || !hasCompleteConfig(config)) return;
		if (event.prompt.trim().length === 0) return;

		// Capture the last two messages for better context
		let previousMessage: string | undefined;
		if (ctx.messages && ctx.messages.length > 0) {
			const messagesToInclude = Math.min(2, ctx.messages.length);
			const recentMessages = ctx.messages.slice(-messagesToInclude);
			const contextParts: string[] = [];
			
			for (const msg of recentMessages) {
				if (msg.content && Array.isArray(msg.content)) {
					const text = msg.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map(c => c.text)
						.join("\n")
						.trim();
					if (text) {
						contextParts.push(`[${msg.role}]: ${text}`);
					}
				}
			}
			
			if (contextParts.length > 0) {
				previousMessage = contextParts.join("\n\n");
			}
		}

		const input: PromptAnalysisInput = {
			prompt: event.prompt,
			images: event.images,
			previousMessage,
		};

		let decision: RouteDecision;
		if (matchesPendingAnalysis(input, pendingAnalysis)) {
			decision = pendingAnalysis!.decision;
			pendingAnalysis = undefined;
		} else {
			beginAnalysisFeedback(ctx);
			try {
				decision = await analyzePrompt(input, ctx, config);
			} finally {
				endAnalysisFeedback(ctx);
			}
		}

		const inputHasImage = hasImageSignal(input);
		const targetModel = await routeToTargetModel(ctx, decision, {
			requireImageInput: inputHasImage,
		});
		if (!targetModel) {
			await disableAutoMode(ctx, false);
			ctx.ui.notify(
				inputHasImage
					? "An image was detected, but no suitable image-capable target model was found. Auto Mode was disabled and control returned to manual mode."
					: "No target model was found for Auto Mode. Auto Mode was disabled and control returned to manual mode.",
				"error",
			);
			return;
		}

		if (!sameModel(ctx.model, targetModel)) {
			const switched = await switchModel(targetModel);
			if (!switched) {
				await disableAutoMode(ctx, false);
				ctx.ui.notify(`Could not switch to target model: ${formatModel(targetModel)}`, "error");
				return;
			}
		}

		lastRoute = decision;
		activeDomain = decision.domain;
		updateStatus(ctx, autoEnabled, lastRoute, phaseState);

		// Build system prompt addition
		const routingLines: string[] = ["[Auto Mode]"];

		if (decision.domain === "frontend") {
			routingLines.push("This turn was classified as frontend-focused. Prioritize visual quality, UX, accessibility, and presentation details.");
		} else if (decision.domain === "terminal") {
			routingLines.push("This turn was classified as terminal-focused. Prioritize direct, safe, and minimal command execution.");
		} else {
			routingLines.push("This turn was classified as logic-focused. Prioritize correctness, data flow, architecture, testing, and debugging.");
		}

		// Multi-domain instructions
		if (decision.isMultiDomain && decision.subtasks && decision.subtasks.length > 1) {
			routingLines.push("");
			routingLines.push("⚠️ IMPORTANT: This task spans multiple domains.");
			routingLines.push("Detected subtasks:");
			for (const st of decision.subtasks) {
				routingLines.push(`  - [${st.domain}] ${st.description}`);
			}
			routingLines.push("");
			routingLines.push("Execution guidance:");
			routingLines.push("1. When the current domain's work is complete, use the switch_domain tool to move to the next domain.");
			routingLines.push("2. Include a short reason when switching domains.");
			routingLines.push("3. Frontend work includes UI design, CSS, styling, component appearance, and responsive behavior.");
			routingLines.push("4. Logic work includes business logic, APIs, data flow, state management, tests, and debugging.");
			routingLines.push("5. Complete the subtasks in order.");
			routingLines.push("6. Do not leave a domain half-finished unless the task explicitly requires switching earlier.");
		}

		// Mid-turn switch instructions
		if (config.midTurnSwitch !== false) {
			routingLines.push("");
			routingLines.push("[Mid-Turn Switching Enabled]");
			routingLines.push("If you need to move to a different area of expertise during the task, use the switch_domain tool.");
			routingLines.push("Example scenarios:");
			routingLines.push("- You finished the logic implementation and now need to work on CSS/styling for a component → switch_domain(\"frontend\")");
			routingLines.push("- You finished the UI work and now need to implement an API endpoint or state logic → switch_domain(\"logic\")");
		}

		return {
			systemPrompt: `${event.systemPrompt}\n\n${routingLines.join("\n")}`,
		};
	});

	// ─── Tool call event (reserved for future use) ────────────



	// ─── Agent end: cleanup ───────────────────────────────────

	pi.on("agent_end", async (_event, ctx) => {
		endAnalysisFeedback(ctx);
		midTurnSwitchCount = 0;

		// Report phase progress
		if (phaseState && phaseState.completedPhases.length > 0) {
			const completed = phaseState.completedPhases.length;
			const total = phaseState.subtasks.length;
			if (completed < total) {
				ctx.ui.notify(
					`📊 Task summary: ${completed + 1}/${total} phases completed. Remaining phases can continue in the next turn.`,
					"info",
				);
			} else {
				ctx.ui.notify("✅ All phases completed.", "info");
				phaseState = undefined;
			}
		}
	});
}
