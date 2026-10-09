//#region ../contract/src/limits.ts
var MB = 1048576;
/** Spec §8 sizes, §9 URL lifetime, §11 CSV rows, §12 retention. */
var LIMITS = {
	fileBytes: 25 * MB,
	folderBytes: 100 * MB,
	folderFiles: 500,
	workspaceBytes: 1024 * MB,
	embedTtlSeconds: 300,
	retentionDays: 30,
	/** An upload session not committed within this many hours is swept. */
	uploadTtlHours: 24,
	/** Files arriving renew a session by uploadTtlHours, never past this many hours after it was declared. */
	uploadMaxHours: 72,
	/** One batch request carries at most this many files and this many bytes of them; a bigger file goes alone. */
	batchFiles: 50,
	batchBytes: 8 * MB,
	csvRows: 5e3
};
//#endregion
//#region ../contract/src/content.ts
/**
* The frame's sandbox (spec §9): scripts and popups that escape it, and nothing else — no
* `allow-same-origin`, so every artifact runs in an opaque origin. The host SDK puts it on the
* `<iframe>`; the content Worker repeats it as a CSP `sandbox` directive on HTML and SVG documents.
*/
var FRAME_SANDBOX = "allow-scripts allow-popups-to-escape-sandbox";
/** Kinds that have text, so `/_view?source=1` can show them: every text view, and HTML. */
var SOURCE_VIEWS = /* @__PURE__ */ new Set([.../* @__PURE__ */ new Set([
	"markdown",
	"code",
	"text",
	"json",
	"yaml",
	"toml",
	"csv",
	"tsv",
	"ipynb",
	"mermaid",
	"graphviz",
	"svg"
]), "html"]);
//#endregion
//#region ../contract/src/protocol.ts
var MAX_FRAME_HEIGHT = 2e4;
var isObj = (d) => typeof d === "object" && d !== null;
var isTheme = (t) => t === "light" || t === "dark" || t === "system";
function isResizeMessage(d) {
	return isObj(d) && d.type === "superlibrary:resize" && typeof d.height === "number" && Number.isFinite(d.height) && d.height >= 0;
}
function isExpiredMessage(d) {
	return isObj(d) && d.type === "superlibrary:expired" && typeof d.path === "string";
}
function isOpenMessage(d) {
	return isObj(d) && d.type === "superlibrary:open" && typeof d.url === "string";
}
/** An absolute http: or https: URL, and nothing else (no javascript:, data:, blob:, relative paths). */
function isWebUrl(url) {
	try {
		const p = new URL(url).protocol;
		return p === "http:" || p === "https:";
	} catch {
		return false;
	}
}
//#endregion
//#region src/icons.ts
/** Toolbar icons, built with DOM calls (no innerHTML, so a host's Trusted Types policy is not involved). */
var PATHS = {
	chevron: "M6 9l6 6 6-6",
	files: "M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01",
	source: "M16 18l6-6-6-6M8 6l-6 6 6 6",
	theme: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 3v18",
	maximize: "M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M16 21h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3",
	minimize: "M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M16 21v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3",
	open: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3",
	download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
	more: "M5 12h.01M12 12h.01M19 12h.01",
	share: "M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7M16 6l-4-4-4 4M12 2v13"
};
var NS = "http://www.w3.org/2000/svg";
function icon(name) {
	const svg = document.createElementNS(NS, "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("width", "18");
	svg.setAttribute("height", "18");
	svg.setAttribute("aria-hidden", "true");
	svg.setAttribute("focusable", "false");
	svg.setAttribute("class", "sl-icon");
	const path = document.createElementNS(NS, "path");
	path.setAttribute("d", PATHS[name]);
	svg.append(path);
	return svg;
}
//#endregion
//#region src/style.ts
/**
* The toolbar's stylesheet, injected once per document. Every rule is under `.sl-embed`, and the
* colours come from host hooks (`--sl-host-bg`, `-fg`, `-muted`, `-line`, `-hover`, `-accent`,
* `-accent-content`, `-danger`, each also with `-dark`, and `--sl-host-font`) with neutral fallbacks.
*/
var CSS = `
.sl-embed{--sl-bg:var(--sl-host-bg,#fff);--sl-fg:var(--sl-host-fg,#1f2328);--sl-muted:var(--sl-host-muted,#59636e);--sl-line:var(--sl-host-line,#d1d9e0);--sl-hover:var(--sl-host-hover,#f0f2f4);--sl-accent:var(--sl-host-accent,#0969da);--sl-accent-content:var(--sl-host-accent-content,#fff);--sl-danger:var(--sl-host-danger,#cf222e);
  container-type:inline-size;display:flex;flex-direction:column;background:var(--sl-bg);color:var(--sl-fg);border:1px solid var(--sl-line);border-radius:8px;overflow:hidden;
  font:14px/1.4 var(--sl-host-font,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif);color-scheme:light}
.sl-embed[data-theme=dark]{--sl-bg:var(--sl-host-bg-dark,#0d1117);--sl-fg:var(--sl-host-fg-dark,#e6edf3);--sl-muted:var(--sl-host-muted-dark,#9198a1);--sl-line:var(--sl-host-line-dark,#3d444d);--sl-hover:var(--sl-host-hover-dark,#1f242c);--sl-accent:var(--sl-host-accent-dark,#4493f8);--sl-accent-content:var(--sl-host-accent-content-dark,#0d1117);--sl-danger:var(--sl-host-danger-dark,#f85149);color-scheme:dark}
@media (prefers-color-scheme:dark){.sl-embed:not([data-theme=light]){--sl-bg:var(--sl-host-bg-dark,#0d1117);--sl-fg:var(--sl-host-fg-dark,#e6edf3);--sl-muted:var(--sl-host-muted-dark,#9198a1);--sl-line:var(--sl-host-line-dark,#3d444d);--sl-hover:var(--sl-host-hover-dark,#1f242c);--sl-accent:var(--sl-host-accent-dark,#4493f8);--sl-accent-content:var(--sl-host-accent-content-dark,#0d1117);--sl-danger:var(--sl-host-danger-dark,#f85149);color-scheme:dark}}
.sl-embed [hidden]{display:none!important}
.sl-embed *,.sl-embed *::before,.sl-embed *::after{box-sizing:border-box}
.sl-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:2px;padding:4px;border-bottom:1px solid var(--sl-line)}
.sl-spacer{flex:1 1 0;min-width:0}
.sl-btn,.sl-select{position:relative;display:inline-flex;align-items:center;gap:6px;min-height:36px;min-width:36px;padding:0 10px;border:0;border-radius:6px;
  background:transparent;color:inherit;font:inherit;text-decoration:none;cursor:pointer;white-space:nowrap}
.sl-btn:hover,.sl-select:hover{background:var(--sl-hover)}
.sl-btn:focus-visible,.sl-select:focus-within,.sl-panel button:focus-visible,.sl-link:focus-visible,.sl-more-item:focus-visible,.sl-more-field select:focus-visible{outline:2px solid var(--sl-accent);outline-offset:-2px}
.sl-btn[aria-pressed=true],.sl-btn[aria-expanded=true]{background:var(--sl-hover);color:var(--sl-accent)}
.sl-icon{flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.sl-select select{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;font:inherit;font-size:max(16px,1em);-webkit-appearance:none;appearance:none}
.sl-version{font-weight:600;font-variant-numeric:tabular-nums}
.sl-caret{width:14px;height:14px;margin-left:-2px;color:var(--sl-muted)}
.sl-error{margin:0;padding:6px 10px;color:var(--sl-danger);border-bottom:1px solid var(--sl-line)}
.sl-panel{padding:10px 12px;border-bottom:1px solid var(--sl-line);display:flex;flex-direction:column;gap:8px}
.sl-panel p{margin:0}
.sl-visibility strong{font-weight:600}
.sl-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.sl-panel button{min-height:36px;padding:0 12px;border:1px solid var(--sl-line);border-radius:6px;background:var(--sl-bg);color:inherit;font:inherit;cursor:pointer}
.sl-panel button:hover{background:var(--sl-hover)}
.sl-panel button.sl-primary{background:var(--sl-accent);border-color:var(--sl-accent);color:var(--sl-accent-content)}
.sl-link{width:100%;min-height:36px;padding:0 8px;border:1px solid var(--sl-line);border-radius:6px;background:var(--sl-hover);color:inherit;font:13px ui-monospace,SFMono-Regular,Menlo,monospace}
.sl-muted,.sl-status{color:var(--sl-muted);font-size:13px}
.sl-status:empty{display:none}
.sl-files-panel{max-height:min(320px,50vh);overflow:auto;padding:4px}
.sl-files-panel ul{list-style:none;margin:0;padding:0}
.sl-panel .sl-file{display:flex;width:100%;gap:12px;justify-content:space-between;align-items:center;border:0;text-align:left;background:transparent}
.sl-panel .sl-file[aria-current=true]{background:var(--sl-hover);color:var(--sl-accent);font-weight:600}
.sl-file-path{overflow-wrap:anywhere}
.sl-file-size{flex:none;color:var(--sl-muted);font-size:12px;font-variant-numeric:tabular-nums}
.sl-frame{display:block;width:100%;border:0;background:var(--sl-bg)}
.sl-embed:fullscreen,.sl-embed.sl-overlay{border:0;border-radius:0}
.sl-embed:-webkit-full-screen{border:0;border-radius:0;width:100%;height:100%}
.sl-embed.sl-overlay{position:fixed;inset:0;z-index:2147483647;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}
.sl-embed:fullscreen .sl-frame,.sl-embed.sl-overlay .sl-frame{flex:1 1 auto;height:auto!important;min-height:0}
.sl-embed:-webkit-full-screen .sl-frame{flex:1 1 auto;height:auto!important;min-height:0}
.sl-more-toggle,.sl-more-panel{display:none!important}
.sl-more-list{display:flex;flex-direction:column;gap:6px}
.sl-panel .sl-more-item{display:flex;align-items:center;min-height:44px;padding:0 12px;border:1px solid var(--sl-line);border-radius:6px;background:var(--sl-bg);color:inherit;text-decoration:none;font:inherit;cursor:pointer}
.sl-more-field{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:44px}
.sl-more-field select{min-height:44px;font:inherit;font-size:max(16px,1em)}
@container (max-width:640px){.sl-toolbar .sl-secondary{display:none}.sl-more-toggle{display:inline-flex!important}.sl-more-panel:not([hidden]){display:flex!important}.sl-btn,.sl-select{padding:0 8px}}
@media (pointer:coarse){.sl-btn,.sl-select,.sl-panel button,.sl-link{min-height:44px;min-width:44px}}
`;
var ID = "sl-embed-style";
function injectStyle(doc, nonce) {
	if (doc.getElementById(ID)) return;
	const style = doc.createElement("style");
	style.id = ID;
	if (nonce) style.nonce = nonce;
	style.textContent = CSS;
	doc.head.append(style);
}
//#endregion
//#region src/view.ts
/** Pure pieces of the toolbar: the frame URL, the visibility words, sizes, the remembered theme. */
/**
* The frame URL for a view. The token signs only item, version, expiry and host, so `path`,
* `source` and `theme` are plain `/_view` parameters and need no new grant. The entry has no
* `path`; `system` has no `theme` (it is the frame's default).
*/
function frameUrl(grant, view) {
	const u = new URL(grant.url);
	if (view.path !== grant.entry) u.searchParams.set("path", view.path);
	if (view.source) u.searchParams.set("source", "1");
	if (view.theme !== "system") u.searchParams.set("theme", view.theme);
	return u.toString();
}
/** Ruling T14: the words are mapped from the API, honestly for phase 1. */
function visibilityWords(info) {
	if (info.scope === "workspace") return "Everyone in the workspace";
	return info.boardVisible ? "This board" : "Only you";
}
function formatBytes(n) {
	if (n < 1024) return `${n} B`;
	if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
var THEME_KEY = "superlibrary:theme";
/** The person's choice on this device. Storage can be missing or throw (private mode, blocked site data). */
function storedTheme() {
	try {
		const t = localStorage.getItem(THEME_KEY);
		return isTheme(t) ? t : null;
	} catch {
		return null;
	}
}
function storeTheme(theme) {
	try {
		localStorage.setItem(THEME_KEY, theme);
	} catch {}
}
//#endregion
//#region src/index.ts
/**
* @superlibrary/embed — mount Superlibrary's viewer in any product (spec §9, Embedding). The host
* mints the URL with its own person's token; the frame needs no sign-in, so it works where
* third-party storage is partitioned (Safari, iOS). The toolbar lives here, outside the sandbox.
*/
/** The frame's sandbox: the contract's, so the SDK and the content Worker's CSP cannot drift apart. */
var SANDBOX = FRAME_SANDBOX;
/** A grant this close to its expiry is minted again before it is used to open anything. */
var STALE_MS = 15e3;
/** An expired message reloads the frame at most this often, whatever the frame says. */
var EXPIRED_EVERY_MS = 1e4;
var TTL_MS = LIMITS.embedTtlSeconds * 1e3;
var THEME_NAMES = {
	system: "System",
	light: "Light",
	dark: "Dark"
};
var mounts = 0;
var message = (e) => e instanceof Error ? e.message : String(e);
function make(tag, props = {}, ...children) {
	const node = Object.assign(document.createElement(tag), props);
	node.append(...children);
	return node;
}
function caret() {
	const c = icon("chevron");
	c.setAttribute("class", "sl-icon sl-caret");
	return c;
}
var labelSpan = (text) => make("span", {
	className: "sl-label",
	textContent: text
});
function toolButton(cls, name, label) {
	const b = make("button", {
		type: "button",
		className: `sl-btn ${cls}`,
		title: label
	}, icon(name), labelSpan(label));
	b.setAttribute("aria-label", label);
	return b;
}
async function mountArtifact(el, opts) {
	const { itemId } = opts;
	const [first, listed] = await Promise.all([opts.getEmbedUrl(opts.version === void 0 ? { itemId } : {
		itemId,
		version: opts.version
	}), opts.getVersions ? opts.getVersions({ itemId }).catch(() => []) : Promise.resolve([])]);
	let grant = first;
	let explicitVersion = opts.version !== void 0;
	const versions = [.../* @__PURE__ */ new Set([...listed, grant.version])].sort((a, b) => b - a);
	const app = (opts.appUrl ?? "https://app.superlibrary.dev").replace(/\/+$/, "");
	const initialHeight = `${opts.height ?? 480}px`;
	let view = {
		path: grant.entry,
		source: false,
		theme: storedTheme() ?? opts.theme ?? "system"
	};
	let shareInfo = null;
	const id = `sl-embed-${++mounts}`;
	const link = () => `${app}/a/${itemId}${explicitVersion ? `/v/${grant.version}` : ""}`;
	const files = () => grant.files ?? [];
	const isFolder = () => files().length > 1;
	const current = () => files().find((f) => f.path === view.path);
	injectStyle(document, opts.nonce);
	const root = make("div", { className: "sl-embed" });
	const bar = make("div", { className: "sl-toolbar" });
	bar.setAttribute("role", "toolbar");
	bar.setAttribute("aria-label", "Artifact");
	const errorEl = make("p", {
		className: "sl-error",
		hidden: true
	});
	errorEl.setAttribute("role", "alert");
	const versionEl = make("span");
	const versionLabel = make("span", { className: "sl-version" });
	const versionSelect = make("select", { className: "sl-versions" });
	versionSelect.setAttribute("aria-label", "Version");
	versionSelect.addEventListener("change", () => void setVersion(Number(versionSelect.value)));
	const renderVersion = () => {
		versionLabel.textContent = `v${grant.version}`;
		if (versions.length < 2) {
			versionEl.className = "sl-btn sl-version-menu";
			versionEl.replaceChildren(versionLabel);
			return;
		}
		versionSelect.replaceChildren(...versions.map((v, i) => make("option", {
			value: String(v),
			textContent: `v${v}${i === 0 ? " (latest)" : ""}`
		})));
		versionSelect.value = String(grant.version);
		versionEl.className = "sl-select sl-version-menu";
		versionEl.title = "Version";
		if (!versionEl.contains(versionSelect)) versionEl.replaceChildren(versionLabel, caret(), versionSelect);
	};
	const filesToggle = toolButton("sl-files-toggle", "files", "Files");
	const filesPanel = make("div", {
		className: "sl-panel sl-files-panel",
		id: `${id}-files`,
		hidden: true
	});
	const sourceBtn = toolButton("sl-source", "source", "View source");
	const themeSelect = make("select", { className: "sl-theme" });
	themeSelect.setAttribute("aria-label", "Theme");
	themeSelect.append(...[
		"system",
		"light",
		"dark"
	].map((t) => make("option", {
		value: t,
		textContent: THEME_NAMES[t]
	})));
	const themeLabel = labelSpan("");
	const themeEl = make("span", {
		className: "sl-select sl-theme-menu",
		title: "Theme"
	}, icon("theme"), themeLabel, caret(), themeSelect);
	const download = make("a", {
		className: "sl-btn sl-download",
		rel: "noopener noreferrer",
		title: "Download"
	}, icon("download"), labelSpan("Download"));
	download.setAttribute("aria-label", "Download");
	const fsBtn = toolButton("sl-fullscreen", "maximize", "Full screen");
	const open = make("a", {
		className: "sl-btn sl-open",
		target: "_blank",
		rel: "noopener noreferrer",
		title: "Open in new window"
	}, icon("open"), labelSpan("Open in new window"));
	open.setAttribute("aria-label", "Open in new window");
	const shareToggle = toolButton("sl-share-toggle", "share", "Share");
	const sharePanel = make("div", {
		className: "sl-panel sl-share-panel",
		id: `${id}-share`,
		hidden: true
	});
	const moreToggle = toolButton("sl-more-toggle", "more", "More");
	const morePanel = make("div", {
		className: "sl-panel sl-more-panel",
		id: `${id}-more`,
		hidden: true
	});
	for (const c of [
		filesToggle,
		sourceBtn,
		themeEl,
		download,
		open
	]) c.classList.add("sl-secondary");
	for (const [toggle, panel] of [
		[filesToggle, filesPanel],
		[shareToggle, sharePanel],
		[moreToggle, morePanel]
	]) {
		toggle.setAttribute("aria-expanded", "false");
		toggle.setAttribute("aria-controls", panel.id);
	}
	const iframe = document.createElement("iframe");
	iframe.className = "sl-frame";
	iframe.setAttribute("sandbox", SANDBOX);
	iframe.setAttribute("referrerpolicy", "no-referrer");
	iframe.setAttribute("title", opts.title ?? "Superlibrary artifact");
	iframe.style.height = initialHeight;
	root.append(bar, errorEl, filesPanel, sharePanel, morePanel, iframe);
	const showError = (text) => {
		errorEl.textContent = text ?? "";
		errorEl.hidden = text === null;
	};
	/** The More panel mirrors the secondary controls the bar shows now; each item uses the bar control itself. */
	let viaMore = false;
	const renderMore = () => {
		const delegate = (label, target) => {
			const b = make("button", {
				type: "button",
				className: "sl-more-item",
				textContent: label
			});
			b.addEventListener("click", () => {
				closePanel(false);
				viaMore = true;
				target.click();
				viaMore = false;
				if (!openPanel) moreToggle.focus();
			});
			return b;
		};
		const items = [];
		if (isFolder()) items.push(delegate(`Files (${files().length})`, filesToggle));
		if (current() !== void 0 && SOURCE_VIEWS.has(current().view)) items.push(delegate(view.source ? "Show rendered" : "View source", sourceBtn));
		const theme = make("select", { className: "sl-more-theme" });
		theme.append(...[
			"system",
			"light",
			"dark"
		].map((t) => make("option", {
			value: t,
			textContent: THEME_NAMES[t]
		})));
		theme.value = themeSelect.value;
		theme.addEventListener("change", () => {
			themeSelect.value = theme.value;
			themeSelect.dispatchEvent(new Event("change"));
		});
		items.push(make("label", { className: "sl-more-field" }, make("span", { textContent: "Theme" }), theme));
		if (grant.downloadUrl) {
			const dl = make("a", {
				className: "sl-more-item",
				href: grant.downloadUrl,
				rel: "noopener noreferrer",
				textContent: "Download"
			});
			dl.addEventListener("click", (e) => {
				e.preventDefault();
				closePanel(false);
				download.click();
				moreToggle.focus();
			});
			items.push(dl);
		}
		items.push(make("a", {
			className: "sl-more-item",
			href: link(),
			target: "_blank",
			rel: "noopener noreferrer",
			textContent: "Open in new window"
		}));
		morePanel.replaceChildren(make("div", { className: "sl-more-list" }, ...items));
	};
	/** Lay the toolbar out for the current grant and file; keeps focus on a control that stays. */
	const renderBar = () => {
		const active = document.activeElement;
		const sourceable = current() !== void 0 && SOURCE_VIEWS.has(current().view);
		const n = files().length;
		filesToggle.setAttribute("aria-label", `Files (${n})`);
		filesToggle.title = `Files (${n})`;
		filesToggle.querySelector(".sl-label").textContent = `Files (${n})`;
		sourceBtn.setAttribute("aria-pressed", String(view.source));
		if (grant.downloadUrl) download.href = grant.downloadUrl;
		open.href = link();
		const children = [versionEl];
		if (isFolder()) children.push(filesToggle);
		if (sourceable) children.push(sourceBtn);
		children.push(make("span", { className: "sl-spacer" }), themeEl);
		if (grant.downloadUrl) children.push(download);
		children.push(fsBtn, open, shareToggle, moreToggle);
		renderMore();
		bar.replaceChildren(...children);
		if (!isFolder() && openPanel?.panel === filesPanel) closePanel(false);
		if (active && active !== document.activeElement && active.isConnected) active.focus();
	};
	const renderFiles = () => {
		const list = make("ul");
		for (const f of files()) {
			const b = make("button", {
				type: "button",
				className: "sl-file"
			}, make("span", {
				className: "sl-file-path",
				textContent: f.path
			}), make("span", {
				className: "sl-file-size",
				textContent: formatBytes(f.bytes)
			}));
			if (f.path === view.path) b.setAttribute("aria-current", "true");
			b.addEventListener("click", () => {
				closePanel(true);
				show({
					path: f.path,
					source: false
				});
			});
			list.append(make("li", {}, b));
		}
		filesPanel.replaceChildren(list);
	};
	let receivedAt = Date.now();
	const lifetime = () => {
		const l = Date.parse(grant.expiresAt) - receivedAt;
		return l >= 5e3 && l <= TTL_MS ? l : TTL_MS;
	};
	const stale = () => Date.now() - receivedAt >= lifetime() - STALE_MS;
	const accept = (g) => {
		grant = g;
		receivedAt = Date.now();
	};
	let epoch = 0;
	/** The grant to use for ticket `mine`, minted again if stale; null if a later choice superseded it. */
	const fresh = async (mine) => {
		if (!stale()) return grant;
		const g = await opts.getEmbedUrl({
			itemId,
			version: grant.version
		});
		if (mine !== epoch) return null;
		accept(g);
		renderBar();
		return grant;
	};
	/** Point the frame at a view of the current version. */
	const show = async (next) => {
		const mine = ++epoch;
		let g;
		try {
			g = await fresh(mine);
		} catch (e) {
			if (mine === epoch) showError(`This could not be opened: ${message(e)}`);
			return;
		}
		if (!g || mine !== epoch) return;
		const before = view;
		view = {
			...view,
			...next
		};
		showError(null);
		iframe.setAttribute("src", frameUrl(g, view));
		iframe.style.height = initialHeight;
		if (before.path !== view.path) {
			renderFiles();
			renderBar();
		} else sourceBtn.setAttribute("aria-pressed", String(view.source));
	};
	const setVersion = async (n) => {
		const mine = ++epoch;
		if (n === grant.version) {
			renderVersion();
			return true;
		}
		let g;
		try {
			g = await opts.getEmbedUrl({
				itemId,
				version: n
			});
		} catch (e) {
			if (mine !== epoch) return false;
			showError(`Version ${n} could not be opened: ${message(e)}`);
			renderVersion();
			return false;
		}
		if (mine !== epoch) return false;
		accept(g);
		explicitVersion = true;
		if (!versions.includes(g.version)) {
			versions.push(g.version);
			versions.sort((a, b) => b - a);
		}
		view = {
			...view,
			path: g.entry,
			source: false
		};
		showError(null);
		iframe.setAttribute("src", frameUrl(g, view));
		iframe.style.height = initialHeight;
		renderVersion();
		renderFiles();
		renderBar();
		shareLink.value = link();
		opts.onVersionChange?.(g.version);
		return true;
	};
	sourceBtn.addEventListener("click", () => void show({ source: !view.source }));
	download.addEventListener("click", (e) => {
		if (!stale()) return;
		e.preventDefault();
		fresh(epoch).then((g) => {
			if (g?.downloadUrl && !stale()) download.click();
		}, (err) => showError(`The download could not start: ${message(err)}`));
	});
	const postTheme = () => iframe.contentWindow?.postMessage({
		type: "superlibrary:theme",
		theme: view.theme
	}, "*");
	const applyTheme = (t) => {
		view = {
			...view,
			theme: t
		};
		themeSelect.value = t;
		themeLabel.textContent = THEME_NAMES[t];
		if (t === "system") root.removeAttribute("data-theme");
		else root.setAttribute("data-theme", t);
		postTheme();
	};
	themeSelect.addEventListener("change", () => {
		const t = themeSelect.value;
		storeTheme(t);
		applyTheme(t);
	});
	iframe.addEventListener("load", postTheme);
	let openPanel = null;
	function closePanel(focusToggle) {
		if (!openPanel) return;
		const { toggle, panel, returnTo } = openPanel;
		openPanel = null;
		panel.hidden = true;
		toggle.setAttribute("aria-expanded", "false");
		if (focusToggle) returnTo.focus();
	}
	const togglePanel = (toggle, panel, focusFirst) => {
		const wasOpen = openPanel?.panel === panel;
		closePanel(false);
		if (wasOpen) return;
		openPanel = {
			toggle,
			panel,
			returnTo: viaMore ? moreToggle : toggle
		};
		panel.hidden = false;
		toggle.setAttribute("aria-expanded", "true");
		focusFirst()?.focus();
	};
	filesToggle.addEventListener("click", () => togglePanel(filesToggle, filesPanel, () => filesPanel.querySelector("[aria-current]")));
	const visibility = make("p", {
		className: "sl-visibility",
		hidden: !opts.getShareInfo
	});
	const widenBox = make("div", { className: "sl-row" });
	const shareLink = make("input", {
		className: "sl-link",
		readOnly: true,
		value: link()
	});
	shareLink.setAttribute("aria-label", "Link");
	const copyBtn = make("button", {
		type: "button",
		className: "sl-copy",
		textContent: "Copy link"
	});
	const shareBtn = make("button", {
		type: "button",
		className: "sl-share",
		textContent: "Share…"
	});
	const status = make("p", { className: "sl-status" });
	status.setAttribute("role", "status");
	sharePanel.append(visibility, widenBox, shareLink, make("div", { className: "sl-row" }, copyBtn, shareBtn), make("p", {
		className: "sl-muted",
		textContent: "People sign in to Superlibrary to open the link, and see it only if they are allowed to."
	}), status);
	const renderShare = (info) => {
		if (info) visibility.replaceChildren("Who can see this: ", make("strong", { textContent: visibilityWords(info) }));
		widenBox.replaceChildren();
		if (!info || !opts.setScope || !info.canWiden || info.scope === "workspace") return;
		const widen = make("button", {
			type: "button",
			className: "sl-widen",
			textContent: "Show to everyone in the workspace…"
		});
		widen.addEventListener("click", () => {
			const confirm = make("button", {
				type: "button",
				className: "sl-widen-confirm sl-primary",
				textContent: "Show it to everyone in the workspace"
			});
			const cancel = make("button", {
				type: "button",
				className: "sl-widen-cancel",
				textContent: "Cancel"
			});
			cancel.addEventListener("click", () => {
				renderShare(shareInfo);
				widenBox.querySelector(".sl-widen")?.focus();
			});
			confirm.addEventListener("click", () => void widenToWorkspace(confirm));
			widenBox.replaceChildren(make("p", { textContent: "Everyone in the workspace will be able to find and open it. This cannot be undone here." }), confirm, cancel);
			confirm.focus();
		});
		widenBox.append(widen);
	};
	let shareLoad = 0;
	const loadShare = async () => {
		if (!opts.getShareInfo) return;
		const mine = ++shareLoad;
		visibility.textContent = "Checking who can see this…";
		try {
			const info = await opts.getShareInfo({ itemId });
			if (mine !== shareLoad) return;
			shareInfo = info;
			renderShare(info);
		} catch (e) {
			if (mine === shareLoad) visibility.textContent = `Who can see this could not be checked: ${message(e)}`;
		}
	};
	async function widenToWorkspace(confirm) {
		confirm.disabled = true;
		status.textContent = "Changing who can see this…";
		try {
			await opts.setScope({
				itemId,
				scope: "workspace"
			});
			const info = await opts.getShareInfo({ itemId });
			shareInfo = info;
			renderShare(info);
			status.textContent = "Everyone in the workspace can see it now.";
			opts.onScopeChange?.(info);
		} catch (e) {
			renderShare(shareInfo);
			status.textContent = `Could not change who can see this: ${message(e)}`;
		}
	}
	const copyLink = async () => {
		const clipboard = opts.clipboard ?? (typeof navigator !== "undefined" ? navigator.clipboard : void 0);
		try {
			if (!clipboard) throw new Error("no clipboard");
			await clipboard.writeText(link());
			status.textContent = "Link copied";
		} catch {
			status.textContent = "Copy failed. Select the link above and copy it.";
			shareLink.select();
		}
	};
	copyBtn.addEventListener("click", () => void copyLink());
	shareBtn.addEventListener("click", async () => {
		if (typeof navigator.share !== "function") return copyLink();
		try {
			await navigator.share({
				title: shareInfo?.title ?? opts.title ?? "Superlibrary artifact",
				url: link()
			});
		} catch (e) {
			if (e instanceof DOMException && e.name === "AbortError") return;
			await copyLink();
		}
	});
	shareToggle.addEventListener("click", () => {
		status.textContent = "";
		togglePanel(shareToggle, sharePanel, () => copyBtn);
		if (openPanel?.panel === sharePanel) loadShare();
	});
	moreToggle.addEventListener("click", () => {
		renderMore();
		togglePanel(moreToggle, morePanel, () => morePanel.querySelector("button, a, select"));
	});
	let overlay = false;
	let nativeOn = false;
	let savedOverflow = "";
	const docEl = document.documentElement;
	const nativeElement = () => document.fullscreenElement ?? document.webkitFullscreenElement ?? null;
	const sentinel = make("span", {
		className: "sl-sentinel",
		tabIndex: 0
	});
	const sentinelStart = make("span", {
		className: "sl-sentinel sl-sentinel-start",
		tabIndex: 0
	});
	const tabbables = () => [...root.querySelectorAll("button, a[href], select, input, iframe")].filter((c) => !c.closest("[hidden]") && !c.disabled);
	sentinel.addEventListener("focus", () => tabbables()[0]?.focus());
	sentinelStart.addEventListener("focus", () => tabbables().at(-1)?.focus());
	let inerted = [];
	let contained = false;
	const contain = (on) => {
		if (on === contained) return;
		contained = on;
		if (on) {
			root.setAttribute("role", "dialog");
			root.setAttribute("aria-modal", "true");
			root.setAttribute("aria-label", `${opts.title ?? "Superlibrary artifact"}, full screen`);
			root.prepend(sentinelStart);
			root.append(sentinel);
			for (let n = root; n !== document.body && n.parentElement; n = n.parentElement) for (const sib of n.parentElement.children) {
				if (sib === n || sib.hasAttribute("inert")) continue;
				sib.setAttribute("inert", "");
				inerted.push(sib);
			}
		} else {
			for (const a of [
				"role",
				"aria-modal",
				"aria-label"
			]) root.removeAttribute(a);
			sentinel.remove();
			sentinelStart.remove();
			for (const sib of inerted) sib.removeAttribute("inert");
			inerted = [];
		}
	};
	const syncFullscreen = () => {
		const on = overlay || nativeElement() === root;
		contain(on);
		const label = on ? "Exit full screen" : "Full screen";
		fsBtn.setAttribute("aria-pressed", String(on));
		fsBtn.setAttribute("aria-label", label);
		fsBtn.title = label;
		fsBtn.replaceChildren(icon(on ? "minimize" : "maximize"), labelSpan(label));
	};
	const enterFullscreen = async () => {
		const request = root.requestFullscreen ?? root.webkitRequestFullscreen;
		if (typeof request === "function") try {
			await request.call(root);
			return;
		} catch {}
		overlay = true;
		savedOverflow = docEl.style.overflow;
		docEl.style.overflow = "hidden";
		root.classList.add("sl-overlay");
		syncFullscreen();
		fsBtn.focus();
	};
	const leaveOverlay = () => {
		overlay = false;
		root.classList.remove("sl-overlay");
		docEl.style.overflow = savedOverflow;
		syncFullscreen();
	};
	const exitFullscreen = () => {
		if (nativeElement() === root) (document.exitFullscreen ?? document.webkitExitFullscreen)?.call(document);
		else if (overlay) {
			leaveOverlay();
			fsBtn.focus();
		}
	};
	fsBtn.addEventListener("click", () => overlay || nativeElement() === root ? exitFullscreen() : void enterFullscreen());
	const onFullscreenChange = () => {
		const on = nativeElement() === root;
		syncFullscreen();
		if (nativeOn && !on) fsBtn.focus();
		nativeOn = on;
	};
	document.addEventListener("fullscreenchange", onFullscreenChange);
	document.addEventListener("webkitfullscreenchange", onFullscreenChange);
	const onKey = (e) => {
		if (e.defaultPrevented || !root.isConnected) return;
		if (e.key === "Tab" && contained) {
			const stops = tabbables();
			const first = stops[0];
			const last = stops.at(-1);
			const active = document.activeElement;
			if (!first || !last) return;
			if (!e.shiftKey && (active === last || !root.contains(active))) {
				e.preventDefault();
				first.focus();
			} else if (e.shiftKey && (active === first || !root.contains(active))) {
				e.preventDefault();
				last.focus();
			}
			return;
		}
		if (e.key !== "Escape") return;
		const inside = e.target instanceof Node && root.contains(e.target);
		if (openPanel && inside) {
			e.preventDefault();
			closePanel(true);
		} else if (overlay) {
			e.preventDefault();
			exitFullscreen();
		}
	};
	const onPointer = (e) => {
		if (openPanel && e.target instanceof Node && !root.contains(e.target)) closePanel(false);
	};
	document.addEventListener("keydown", onKey);
	document.addEventListener("pointerdown", onPointer);
	const onMessage = (e) => {
		if (e.source !== iframe.contentWindow || e.origin !== "null") return;
		if (isResizeMessage(e.data)) iframe.style.height = `${Math.min(Math.ceil(e.data.height), MAX_FRAME_HEIGHT)}px`;
		else if (isOpenMessage(e.data) && isWebUrl(e.data.url)) window.open(e.data.url, "_blank", "noopener,noreferrer");
		else if (isExpiredMessage(e.data)) onExpired(e.data.path);
	};
	let lastExpiredReload = -Infinity;
	const onExpired = async (path) => {
		if (!stale() || Date.now() - lastExpiredReload < EXPIRED_EVERY_MS) return;
		lastExpiredReload = Date.now();
		const mine = epoch;
		let g;
		try {
			g = await opts.getEmbedUrl({
				itemId,
				version: grant.version
			});
		} catch (err) {
			if (mine === epoch) showError(`This could not be opened again: ${message(err)}`);
			return;
		}
		if (mine !== epoch) return;
		accept(g);
		const moved = files().find((f) => f.path === path && f.view === "html" && path !== view.path);
		if (moved) view = {
			...view,
			path: moved.path,
			source: false
		};
		iframe.setAttribute("src", frameUrl(g, view));
		iframe.style.height = initialHeight;
		renderFiles();
		renderBar();
	};
	window.addEventListener("message", onMessage);
	renderVersion();
	renderFiles();
	renderBar();
	syncFullscreen();
	applyTheme(view.theme);
	iframe.setAttribute("src", frameUrl(grant, view));
	el.append(root);
	return {
		iframe,
		setTheme: (theme) => applyTheme(theme),
		setVersion,
		destroy: () => {
			window.removeEventListener("message", onMessage);
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("pointerdown", onPointer);
			document.removeEventListener("fullscreenchange", onFullscreenChange);
			document.removeEventListener("webkitfullscreenchange", onFullscreenChange);
			if (overlay) leaveOverlay();
			contain(false);
			if (nativeElement() === root) exitFullscreen();
			root.remove();
		}
	};
}
//#endregion
export { SANDBOX, formatBytes, mountArtifact, visibilityWords };
