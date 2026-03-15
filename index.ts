import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { complete, type ImageContent, type Model } from "@mariozechner/pi-ai";
import { getSettingsListTheme } from "@mariozechner/pi-coding-agent";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	Theme,
} from "@mariozechner/pi-coding-agent";
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

type RouteDomain = "frontend" | "logic" | "terminal";
type DecisionSource = "analyzer" | "heuristic" | "fallback";

type AutoModeConfig = {
	version: 1;
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
};

type PromptAnalysisInput = {
	prompt: string;
	images?: ImageContent[];
};

type PendingAnalysis = PromptAnalysisInput & {
	decision: RouteDecision;
};

const AUTO_PROVIDER = "auto";
const AUTO_MODEL_ID = "mode";
const CONFIG_PATH = join(homedir(), ".pi", "agent", "auto-mode-router.json");

const FRONTEND_KEYWORDS = [
	"ui",
	"ux",
	"design",
	"tasarım",
	"css",
	"tailwind",
	"style",
	"styling",
	"layout",
	"responsive",
	"component",
	"buton",
	"button",
	"form",
	"modal",
	"dialog",
	"sidebar",
	"navbar",
	"header",
	"footer",
	"theme",
	"renk",
	"color",
	"spacing",
	"animation",
	"animasyon",
	"page",
	"screen",
	"figma",
	"wireframe",
	"a11y",
	"accessibility",
	"glassmorphism",
	"neubrutalism",
	"claymorphism",
	"frontend",
];

const LOGIC_KEYWORDS = [
	"logic",
	"mantık",
	"backend",
	"api",
	"endpoint",
	"server",
	"database",
	"db",
	"query",
	"migration",
	"auth",
	"permission",
	"validation",
	"schema",
	"bug",
	"fix",
	"hata",
	"debug",
	"test",
	"unit test",
	"integration",
	"algorithm",
	"refactor",
	"performance",
	"cache",
	"state",
	"zustand",
	"redux",
	"reducer",
	"service",
	"controller",
	"worker",
	"queue",
	"cron",
	"serialization",
	"parsing",
	"parser",
	"types",
	"type error",
	"compile",
];

function defaultConfig(): AutoModeConfig {
	return { version: 1 };
}

function loadConfig(): AutoModeConfig {
	if (!existsSync(CONFIG_PATH)) return defaultConfig();

	try {
		const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Partial<AutoModeConfig>;
		return {
			version: 1,
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

function hasCompleteConfig(config: AutoModeConfig): boolean {
	return Boolean(config.analysisModelKey && config.frontendModelKey && config.logicModelKey);
}

function formatModel(model?: Pick<Model<any>, "provider" | "id" | "name" | "reasoning" | "input">): string {
	if (!model) return "ayarlanmadı";
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

function describeConfig(ctx: ExtensionContext, config: AutoModeConfig, autoEnabled: boolean, lastRoute?: RouteDecision): string {
	const analysis = formatModel(findModel(ctx, config.analysisModelKey));
	const frontend = formatModel(findModel(ctx, config.frontendModelKey));
	const logic = formatModel(findModel(ctx, config.logicModelKey));
	const manual = formatModel(findModel(ctx, config.lastManualModelKey));
	const mode = autoEnabled ? "Açık" : "Kapalı";
	const last = lastRoute ? `${lastRoute.domain} (${Math.round(lastRoute.confidence * 100)}%)` : "yok";

	return [
		`Auto Mode: ${mode}`,
		`Analiz modeli: ${analysis}`,
		`Frontend modeli: ${frontend}`,
		`Logic modeli: ${logic}`,
		`Son manuel model: ${manual}`,
		`Son karar: ${last}`,
		`Konfigürasyon dosyası: ${CONFIG_PATH}`,
	].join("\n");
}

function updateStatus(ctx: ExtensionContext, autoEnabled: boolean, lastRoute?: RouteDecision): void {
	if (!autoEnabled) {
		ctx.ui.setStatus("auto-mode", undefined);
		return;
	}

	const label = lastRoute ? `auto:${lastRoute.domain}` : "auto:armed";
	ctx.ui.setStatus("auto-mode", ctx.ui.theme.fg("accent", label));
}

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

function isLikelyTerminalOnlyPrompt(prompt: string, imageCount: number): boolean {
	if (imageCount > 0) return false;
	const text = prompt.toLowerCase().trim();
	const rawCommandPattern = /^(?:!{1,2}\s*)?(git|npm|pnpm|yarn|npx|node|python|pip|docker|kubectl|ls|pwd|cd|mkdir|rm|mv|cp|cat|grep|find|chmod|curl|wget)\b/;
	const explicitTerminalPattern = /\b(git commit yap|git status bak|komutu çalıştır|run this command|bu komutu çalıştır|sadece komutu çalıştır)\b/;
	const combinedTaskPattern = /[,;]\s*|\b(ve|ayrıca|sonra|ardından|but also|and then|and also)\b/;
	if (!(rawCommandPattern.test(text) || explicitTerminalPattern.test(text))) return false;
	return !combinedTaskPattern.test(text);
}

function heuristicDecision(prompt: string, imageCount: number): RouteDecision {
	const text = prompt.toLowerCase();
	const frontendScore = countMatches(text, FRONTEND_KEYWORDS) + (imageCount > 0 ? 1 : 0);
	const logicScore = countMatches(text, LOGIC_KEYWORDS);
	if (isLikelyTerminalOnlyPrompt(prompt, imageCount)) {
		return {
			domain: "terminal",
			confidence: 0.7,
			reason: "İstek tek başına terminal / git komutu çalıştırmaya benziyor",
			source: "heuristic",
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
				? "UI / tasarım anahtar kelimeleri daha baskın"
				: "Mantık / veri akışı anahtar kelimeleri daha baskın",
		source: "heuristic",
	};
}

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
		return {
			domain,
			confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.7,
			reason: parsed.reason?.trim() || "Analyzer response",
			source: "analyzer",
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

function buildAnalyzerPrompt(prompt: string, imageCount: number): string {
	return [
		"Sen bir model yönlendirme analizcisisin.",
		"Görevin kullanıcının son promptunun baskın ihtiyacını sadece üç kategoriden birine ayırmak:",
		"- frontend: UI tasarımı, görsel düzen, stil, CSS, component görünümü, responsive davranış, erişilebilirlik, UX polish",
		"- logic: business logic, backend, veri akışı, bug fix, algoritma, state yönetimi, test, refactor, performans, entegrasyon",
		"- terminal: istek esasen tek başına bir terminal / shell / git komutu çalıştırma isteği ise",
		"Kurallar:",
		"- Sadece baskın amacı seç.",
		"- Karışık isteklerde asıl çıktının ne olduğuna bak.",
		"- Eğer görsel/presentational kısım baskınsa frontend seç.",
		"- Eğer doğruluk, veri, davranış veya hata çözümü baskınsa logic seç.",
		"- Terminal seçimini sadece kullanıcının asıl isteği tek başına bir komut çalıştırmaksa kullan.",
		"- Eğer terminal / commit / bash isteği başka bir gerçek görevle birlikte geliyorsa terminal seçme; asıl göreve göre frontend veya logic seç.",
		"- UI dışındaki genel yazılım görevlerinde varsayılan olarak logic seç.",
		"- Sadece geçerli JSON döndür. Başka hiçbir şey yazma.",
		"JSON şeması: {\"category\":\"frontend|logic|terminal\",\"confidence\":0.0,\"reason\":\"kısa açıklama\"}",
		imageCount > 0 ? `Kullanıcı ${imageCount} görsel ekledi.` : "Kullanıcı görsel eklemedi.",
		"",
		"<prompt>",
		prompt,
		"</prompt>",
	].join("\n");
}

function buildAnalyzerContent(input: PromptAnalysisInput, model: Model<any>): Array<{ type: "text"; text: string } | ImageContent> {
	const content: Array<{ type: "text"; text: string } | ImageContent> = [
		{ type: "text", text: buildAnalyzerPrompt(input.prompt, input.images?.length ?? 0) },
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
	const fallback = heuristicDecision(input.prompt, input.images?.length ?? 0);
	const analyzerModel = findModel(ctx, config.analysisModelKey);
	if (!analyzerModel) return { ...fallback, source: "fallback", reason: "Analiz modeli bulunamadı, sezgisel yönlendirme kullanıldı" };

	try {
		const apiKey = await ctx.modelRegistry.getApiKey(analyzerModel);
		if (!apiKey) {
			return { ...fallback, source: "fallback", reason: "Analiz modeli için kimlik bulunamadı, sezgisel yönlendirme kullanıldı" };
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
		return { ...fallback, source: "fallback", reason: "Analiz isteği başarısız oldu, sezgisel yönlendirme kullanıldı" };
	}
}

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
			lines.push(truncateToWidth(theme.fg("muted", "Yazmaya başla → fuzzy filtre • ↑↓ gezin • Enter seç • Esc geri"), width));
			lines.push("");
			lines.push(truncateToWidth(theme.fg("dim", "Ara:"), width));
			lines.push(...searchInput.render(width).map((line) => truncateToWidth(line, width)));
			lines.push("");

			if (filteredItems.length === 0) {
				lines.push(truncateToWidth(theme.fg("warning", "Eşleşen model bulunamadı."), width));
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

async function configureAutoMode(
	ctx: ExtensionContext,
	config: AutoModeConfig,
	options?: { forceDialog?: boolean },
): Promise<boolean> {
	const models = getSelectableModels(ctx);
	if (models.length === 0) {
		ctx.ui.notify("Auto Mode için seçilebilir model bulunamadı. Önce /login veya API anahtarlarını ayarlayın.", "warning");
		return false;
	}

	if (!ctx.hasUI) {
		return hasCompleteConfig(config);
	}

	const draft: AutoModeConfig = {
		...config,
		version: 1,
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
					label: "Analiz modeli",
					description: "Her promptu önce sınıflandıran hafif model.",
					currentValue: formatModel(findModel(ctx, draft.analysisModelKey) || models[0]),
					submenu: (currentValue, submenuDone) => createModelPicker(theme, models, currentValue, submenuDone),
				},
				{
					id: "frontend",
					label: "Frontend modeli",
					description: "UI, tasarım, CSS, görünüm ve UX odaklı promptlarda kullanılır.",
					currentValue: formatModel(findModel(ctx, draft.frontendModelKey) || models[0]),
					submenu: (currentValue, submenuDone) => createModelPicker(theme, models, currentValue, submenuDone),
				},
				{
					id: "logic",
					label: "Logic modeli",
					description: "Mantık, backend, debug, veri akışı ve test odaklı promptlarda kullanılır.",
					currentValue: formatModel(findModel(ctx, draft.logicModelKey) || models[0]),
					submenu: (currentValue, submenuDone) => createModelPicker(theme, models, currentValue, submenuDone),
				},
			];

			const container = new Container();
			container.addChild(new Text(theme.fg("accent", theme.bold("Auto Mode Configuration")), 1, 1));
			container.addChild(
				new Text(
					theme.fg("muted", "Enter veya Space ile aramalı model görünümünü aç. İçeride yazarak filtrele, Enter ile seç."),
					1,
					0,
				),
			);

			const settingsList = new SettingsList(
				items,
				Math.min(items.length + 3, 10),
				getSettingsListTheme(),
				(id, newValue) => {
					const key = valueMap.get(newValue);
					if (!key) return;
					if (id === "analysis") draft.analysisModelKey = key;
					if (id === "frontend") draft.frontendModelKey = key;
					if (id === "logic") draft.logicModelKey = key;
				},
				() => done(false),
			);

			container.addChild(settingsList);
			container.addChild(
				new Text(
					theme.fg("dim", "Ctrl+S kaydet • Esc vazgeç • Bu seçimler Auto Mode açıkken her promptta tekrar kullanılacak."),
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
	saveConfig(config);
	ctx.ui.notify("Auto Mode konfigürasyonu kaydedildi.", "info");
	return true;
}

export default function autoModeRouter(pi: ExtensionAPI) {
	let config = loadConfig();
	let autoEnabled = false;
	let internalModelSwitchDepth = 0;
	let lastRoute: RouteDecision | undefined;
	let shouldRevertToAuto = false;
	let pendingAnalysis: PendingAnalysis | undefined;

	const withInternalModelSwitch = async (fn: () => Promise<boolean>): Promise<boolean> => {
		internalModelSwitchDepth += 1;
		try {
			return await fn();
		} finally {
			internalModelSwitchDepth -= 1;
		}
	};

	const switchModel = async (model: Model<any>): Promise<boolean> => withInternalModelSwitch(() => pi.setModel(model));

	const rememberManualModel = (ctx: ExtensionContext): void => {
		if (ctx.model && !isAutoModel(ctx.model)) {
			config.lastManualModelKey = toModelKey(ctx.model);
			saveConfig(config);
		}
	};

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
		return pending.prompt === input.prompt && (pending.images?.length ?? 0) === (input.images?.length ?? 0);
	};

	const activateAutoMode = async (ctx: ExtensionContext): Promise<boolean> => {
		const configured = await configureAutoMode(ctx, config, {
			forceDialog: ctx.hasUI,
		});
		if (!configured) return false;

		rememberManualModel(ctx);
		const autoModel = ctx.modelRegistry.find(AUTO_PROVIDER, AUTO_MODEL_ID);
		if (!autoModel) {
			ctx.ui.notify("Auto Mode sanal modeli bulunamadı. /reload deneyin.", "error");
			return false;
		}

		autoEnabled = true;
		lastRoute = undefined;
		updateStatus(ctx, autoEnabled, lastRoute);
		const success = await switchModel(autoModel);
		if (!success) {
			autoEnabled = false;
			updateStatus(ctx, autoEnabled, lastRoute);
			ctx.ui.notify("Auto Mode etkinleştirilemedi.", "error");
			return false;
		}

		ctx.ui.notify("Auto Mode etkin. Her prompt önce analiz edilip uygun modele yönlendirilecek.", "info");
		return true;
	};

	const disableAutoMode = async (ctx: ExtensionContext, notify = true): Promise<void> => {
		autoEnabled = false;
		shouldRevertToAuto = false;
		pendingAnalysis = undefined;
		lastRoute = undefined;
		updateStatus(ctx, autoEnabled, lastRoute);
		endAnalysisFeedback(ctx);

		if (isAutoModel(ctx.model)) {
			const fallback = getFallbackManualModel(ctx, config);
			if (fallback) {
				await switchModel(fallback);
			}
		}

		if (notify) {
			ctx.ui.notify("Auto Mode kapatıldı. Manuel model seçimine dönüldü.", "info");
		}
	};

	const routeToTargetModel = async (ctx: ExtensionContext, decision: RouteDecision): Promise<Model<any> | undefined> => {
		if (decision.domain === "terminal") {
			return findModel(ctx, config.analysisModelKey) || getFallbackManualModel(ctx, config);
		}
		const primaryKey = decision.domain === "frontend" ? config.frontendModelKey : config.logicModelKey;
		const alternateKey = decision.domain === "frontend" ? config.logicModelKey : config.frontendModelKey;
		return findModel(ctx, primaryKey) || findModel(ctx, alternateKey) || getFallbackManualModel(ctx, config);
	};

	const showStatus = (ctx: ExtensionContext): void => {
		ctx.ui.notify(describeConfig(ctx, config, autoEnabled, lastRoute), "info");
	};

	const openCommandMenu = async (ctx: ExtensionCommandContext): Promise<void> => {
		const choice = await ctx.ui.select("Auto Mode", [
			"Etkinleştir",
			"Yapılandır / modelleri değiştir",
			"Durumu göster",
			"Kapat",
		]);

		if (choice === "Etkinleştir") {
			await activateAutoMode(ctx);
			return;
		}
		if (choice === "Yapılandır / modelleri değiştir") {
			await configureAutoMode(ctx, config, { forceDialog: true });
			updateStatus(ctx, autoEnabled, lastRoute);
			return;
		}
		if (choice === "Durumu göster") {
			showStatus(ctx);
			return;
		}
		if (choice === "Kapat") {
			await disableAutoMode(ctx);
		}
	};

	pi.registerProvider(AUTO_PROVIDER, {
		baseUrl: "http://127.0.0.1/auto-mode-router",
		apiKey: "AUTO_MODE_LOCAL",
		api: "openai-completions",
		streamSimple: () => {
			throw new Error("Auto Mode yönlendirmesi gerçekleşmedi. /auto-mode ile konfigürasyonu kontrol edin.");
		},
		models: [
			{
				id: AUTO_MODEL_ID,
				name: "Auto Mode",
				reasoning: false,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000,
				maxTokens: 32_000,
			},
		],
	});

	const handleCommand = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		const action = args.trim().toLowerCase();
		if (!action) {
			await openCommandMenu(ctx);
			return;
		}

		if (["on", "enable", "start", "aç", "ac"].includes(action)) {
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
			updateStatus(ctx, autoEnabled, lastRoute);
			return;
		}

		ctx.ui.notify("Kullanım: /auto-mode [on|off|status|config]", "warning");
	};

	pi.registerCommand("auto-mode", {
		description: "Auto Mode yönlendiricisini aç, kapat veya yapılandır",
		handler: handleCommand,
	});

	pi.registerCommand("auto", {
		description: "Auto Mode kısa komutu",
		handler: handleCommand,
	});

	pi.on("input", async (event, ctx) => {
		if (!autoEnabled || !hasCompleteConfig(config)) return { action: "continue" };
		if (event.source === "extension") return { action: "continue" };
		if (event.text.trim().length === 0) return { action: "continue" };

		const input: PromptAnalysisInput = {
			prompt: event.text,
			images: event.images,
		};

		pendingAnalysis = undefined;
		beginAnalysisFeedback(ctx);
		try {
			const decision = await analyzePrompt(input, ctx, config);
			pendingAnalysis = { ...input, decision };
		} finally {
			endAnalysisFeedback(ctx);
		}

		return { action: "continue" };
	});

	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig();
		pendingAnalysis = undefined;
		autoEnabled = isAutoModel(ctx.model);
		if (!autoEnabled) rememberManualModel(ctx);

		if (autoEnabled && !hasCompleteConfig(config)) {
			ctx.ui.notify("Auto Mode seçili ama konfigüre edilmemiş. Manuel modele geri dönülüyor.", "warning");
			await disableAutoMode(ctx, false);
			return;
		}

		updateStatus(ctx, autoEnabled, lastRoute);
	});

	pi.on("model_select", async (event, ctx) => {
		if (internalModelSwitchDepth > 0) return;

		if (isAutoModel(event.model)) {
			autoEnabled = true;
			lastRoute = undefined;
			updateStatus(ctx, autoEnabled, lastRoute);

			if (ctx.hasUI && event.source !== "restore") {
				const configured = await configureAutoMode(ctx, config, { forceDialog: true });
				if (!configured) {
					autoEnabled = false;
					updateStatus(ctx, autoEnabled, lastRoute);
					const fallback = event.previousModel || getFallbackManualModel(ctx, config);
					if (fallback) await switchModel(fallback);
					ctx.ui.notify("Auto Mode kurulumu iptal edildi.", "warning");
					return;
				}
			}

			if (event.source !== "restore") {
				ctx.ui.notify("Auto Mode etkin. Promptlar otomatik olarak analiz edilip yönlendirilecek.", "info");
			}
			return;
		}

		pendingAnalysis = undefined;
		config.lastManualModelKey = toModelKey(event.model);
		saveConfig(config);

		if (autoEnabled) {
			autoEnabled = false;
			shouldRevertToAuto = false;
			lastRoute = undefined;
			updateStatus(ctx, autoEnabled, lastRoute);
			ctx.ui.notify("Manuel model seçildi, Auto Mode kapatıldı.", "info");
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!autoEnabled || !hasCompleteConfig(config)) return;
		if (event.prompt.trim().length === 0) return;

		const input: PromptAnalysisInput = {
			prompt: event.prompt,
			images: event.images,
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

		const targetModel = await routeToTargetModel(ctx, decision);
		if (!targetModel) {
			await disableAutoMode(ctx, false);
			ctx.ui.notify("Auto Mode için hedef model bulunamadı, manuel moda dönüldü.", "error");
			return;
		}

		const switched = await switchModel(targetModel);
		if (!switched) {
			await disableAutoMode(ctx, false);
			ctx.ui.notify(`Hedef model seçilemedi: ${formatModel(targetModel)}`, "error");
			return;
		}

		lastRoute = decision;
		shouldRevertToAuto = true;
		updateStatus(ctx, autoEnabled, lastRoute);
		ctx.ui.notify(`Auto Mode: ${targetModel.id}`, "info");

		const routingNote =
			decision.domain === "frontend"
				? "Bu tur UI / tasarım odaklı sınıflandırıldı. Görsel kalite, UX, erişilebilirlik ve sunum detaylarını önceliklendir."
				: decision.domain === "terminal"
					? "Bu tur tek başına terminal / komut odaklı sınıflandırıldı. Doğrudan, güvenli ve minimal komut yürütmeye öncelik ver."
					: "Bu tur mantık odaklı sınıflandırıldı. Doğruluk, veri akışı, mimari, test ve hata çözümünü önceliklendir.";

		return {
			systemPrompt: `${event.systemPrompt}\n\n[Auto Mode]\n${routingNote}`,
		};
	});

	pi.on("agent_end", async (_event, ctx) => {
		endAnalysisFeedback(ctx);
		if (!autoEnabled || !shouldRevertToAuto) return;
		const autoModel = ctx.modelRegistry.find(AUTO_PROVIDER, AUTO_MODEL_ID);
		if (!autoModel) return;
		shouldRevertToAuto = false;
		await switchModel(autoModel);
		updateStatus(ctx, autoEnabled, undefined);
	});
}
