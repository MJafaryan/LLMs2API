/**
 * DeepSeek API Server - Stateless with Parallel Support
 * OpenAI-compatible endpoint for DeepSeek chat
 * Each request = new DeepSeek chat (no session/context)
 */

import http from "http";
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

// ==================== Configuration ====================
const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN || "sk-deepseek";
const TARGET_URL = "https://chat.deepseek.com/";
const HEADLESS = process.env.HEADLESS === "true";
const STATE_FILE = path.join(process.cwd(), "browser-state.json");
const MAX_PAGES = parseInt(process.env.MAX_PAGES) || 10;
const PAGE_IDLE_TIMEOUT = 60 * 1000;

// ==================== Globals ====================
let browser = null;
let context = null;
let pagePool = []; // { page, busy, id, lastUsed }
let pageIdCounter = 0;
let isInitializing = false;

// ==================== Logger ====================
function log(level, msg, meta = {}) {
    const ts = new Date().toISOString();
    const metaStr = Object.keys(meta).length
        ? " | " + JSON.stringify(meta)
        : "";
    console.log(`${ts} [${level}] ${msg}${metaStr}`);
}

// ==================== Browser Utils ====================
function sleep(min, max = min) {
    const ms = max > min ? Math.floor(Math.random() * (max - min) + min) : min;
    return new Promise((r) => setTimeout(r, ms));
}

// ==================== Browser Init ====================
async function initBrowser() {
    if (browser || isInitializing) return;
    isInitializing = true;

    log("INFO", "Starting browser...");
    browser = await chromium.launch({
        executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined,
        headless: HEADLESS,
        args: ["--disable-blink-features=AutomationControlled"],
    });

    const contextOptions = {
        userAgent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    };

    if (fs.existsSync(STATE_FILE)) {
        log("INFO", "Loading saved browser state...");
        contextOptions.storageState = STATE_FILE;
    }

    context = await browser.newContext(contextOptions);

    // Create initial page
    const initialPage = await createNewPage();
    log("INFO", "Navigating to DeepSeek...");
    await initialPage.page.goto(TARGET_URL, {
        waitUntil: "domcontentloaded",
        timeout: 120000,
    });
    await sleep(3000, 5000);
    initialPage.busy = false;
    initialPage.lastUsed = Date.now();

    // Start cleanup intervals
    setInterval(cleanupIdlePages, 30000);
    setInterval(saveState, 30000);
    isInitializing = false;

    log(
        "INFO",
        `Browser ready. Pages will be created on demand (max: ${MAX_PAGES})`,
    );
}

async function createNewPage() {
    const page = await context.newPage();
    const pageObj = {
        page,
        busy: true,
        id: pageIdCounter++,
        lastUsed: Date.now(),
    };
    pagePool.push(pageObj);
    log("INFO", `Created new page ${pageObj.id} (total: ${pagePool.length})`);
    return pageObj;
}

async function cleanupIdlePages() {
    const now = Date.now();
    const toRemove = [];
    const minPages = 1;

    for (const p of pagePool) {
        if (
            !p.busy &&
            pagePool.length > minPages &&
            now - p.lastUsed > PAGE_IDLE_TIMEOUT
        ) {
            if (pagePool.length - toRemove.length > minPages) {
                toRemove.push(p);
            }
        }
    }

    for (const p of toRemove) {
        if (pagePool.length <= minPages) break;
        try {
            await p.page.close();
            pagePool = pagePool.filter((x) => x.id !== p.id);
            log(
                "INFO",
                `Closed idle page ${p.id} (remaining: ${pagePool.length})`,
            );
        } catch (e) {
            log("WARN", `Failed to close page ${p.id}`, { error: e.message });
        }
    }
}

async function saveState() {
    if (!context) return;
    try {
        await context.storageState({ path: STATE_FILE });
    } catch (e) {
        log("WARN", "Failed to save state", { error: e.message });
    }
}

async function getAvailablePage() {
    for (const p of pagePool) {
        if (!p.busy) {
            p.busy = true;
            p.lastUsed = Date.now();
            log("INFO", `Reusing page ${p.id}`);
            return p;
        }
    }

    if (pagePool.length < MAX_PAGES) {
        return await createNewPage();
    }

    log("INFO", `All ${MAX_PAGES} pages busy, waiting...`);
    return new Promise((resolve) => {
        const check = setInterval(() => {
            for (const p of pagePool) {
                if (!p.busy) {
                    p.busy = true;
                    p.lastUsed = Date.now();
                    clearInterval(check);
                    log("INFO", `Page ${p.id} became available`);
                    resolve(p);
                    return;
                }
            }
        }, 100);
    });
}

function releasePage(pageObj) {
    pageObj.busy = false;
    pageObj.lastUsed = Date.now();
}

// ==================== Browser Utils ====================
async function pasteText(page, selector, text) {
    const el = await page.$(selector);
    if (!el) throw new Error(`Element not found: ${selector}`);
    await el.focus();
    await page.evaluate((content) => {
        document.execCommand("insertText", false, content);
    }, text);
}

async function toggleButton(page, buttonName, targetState) {
    try {
        const btn = page.getByRole("button", { name: buttonName });
        const btnCount = await btn.count();
        if (btnCount === 0) return false;

        const isSelected = await btn.evaluate((el) =>
            el.classList.contains("ds-toggle-button--selected"),
        );
        if (isSelected !== targetState) {
            await btn.click();
            await sleep(300, 500);
        }
        return true;
    } catch {
        return false;
    }
}

function buildPrompt(request) {
    const openAIRequest = {
        model: request.model ?? "deepseek-v3.2",
        messages: request.messages ?? [],
        ...(request.tools !== undefined && { tools: request.tools }),
        ...(request.tool_choice !== undefined && {
            tool_choice: request.tool_choice,
        }),
    };

    return `Act as an OpenAI-compatible API.
Input: a Chat Completions JSON. Output: Another json with openAI-compatible API that can be used for an harnes or agent.
No markdown, no quotes around the whole thing, no preamble, no apologies, no meta.
If JSON is expected, emit one-line valid JSON. Language = user's language.
<OPENAI_REQUEST>
${JSON.stringify(openAIRequest, null, 2)}
</OPENAI_REQUEST>`;
}

function parseModelResponse(text) {
    const parsed = JSON.parse(text);

    return {
        message: parsed.choices[0].message,
        finishReason: parsed.choices[0].finish_reason,
    };
}

// ==================== DeepSeek Generate ====================
async function generate(prompt, modelId = "deepseek-v3.2", onChunk = null) {
    if (!pagePool.length) throw new Error("Browser not initialized");

    const isStreaming = typeof onChunk === "function";
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const pageObj = await getAvailablePage();
    const page = pageObj.page;

    log("INFO", `Starting generation on page ${pageObj.id}...`, {
        model: modelId,
        streaming: isStreaming,
        requestId,
    });

    try {
        // Navigate to fresh chat
        await page.goto(TARGET_URL, {
            waitUntil: "domcontentloaded",
            timeout: 120000,
        });
        await sleep(2000, 3000);

        // Inject interceptors for SSE capture (fetch, XHR, and EventSource)
        await page.evaluate((reqId) => {
            if (!window.__deepseekRequests) {
                window.__deepseekRequests = {};
            }

            window.__deepseekRequests[reqId] = {
                chunks: [],
                complete: false,
                error: null,
                active: true,
                responseFragmentIndex: -1,
                currentFragmentIndex: -1,
                fragmentCount: 0,
                debug: [],
            };

            // Helper to parse SSE data
            const parseSSEData = (text, req) => {
                const lines = text.split("\n");
                for (const line of lines) {
                    if (line.startsWith("event:") || !line.startsWith("data:"))
                        continue;
                    const dataStr = line.slice(5).trim();
                    if (!dataStr || dataStr === "{}") continue;

                    try {
                        const data = JSON.parse(dataStr);

                        // Initial fragments
                        if (
                            data.v?.response?.fragments &&
                            Array.isArray(data.v.response.fragments)
                        ) {
                            for (const fragment of data.v.response.fragments) {
                                const idx = req.fragmentCount++;
                                if (fragment.type === "RESPONSE") {
                                    req.responseFragmentIndex = idx;
                                    req.currentFragmentIndex = idx;
                                    if (fragment.content)
                                        req.chunks.push(fragment.content);
                                } else {
                                    req.currentFragmentIndex = idx;
                                }
                            }
                        }

                        // Simple text append
                        if (
                            data.v &&
                            typeof data.v === "string" &&
                            !data.p &&
                            !data.o
                        ) {
                            if (
                                req.currentFragmentIndex ===
                                    req.responseFragmentIndex &&
                                req.responseFragmentIndex >= 0
                            ) {
                                req.chunks.push(data.v);
                            }
                        }

                        // APPEND with path
                        if (
                            data.o === "APPEND" &&
                            data.p &&
                            typeof data.v === "string"
                        ) {
                            const match = data.p.match(
                                /response\/fragments\/(\d+)\/content/,
                            );
                            if (match) {
                                const fragIdx = parseInt(match[1], 10);
                                req.currentFragmentIndex = fragIdx;
                                if (fragIdx === req.responseFragmentIndex)
                                    req.chunks.push(data.v);
                            }
                        }

                        // Path without operator
                        if (data.p && typeof data.v === "string" && !data.o) {
                            const match = data.p.match(
                                /response\/fragments\/(\d+)\/content/,
                            );
                            if (match) {
                                const fragIdx = parseInt(match[1], 10);
                                req.currentFragmentIndex = fragIdx;
                                if (fragIdx === req.responseFragmentIndex)
                                    req.chunks.push(data.v);
                            }
                        }

                        // fragments APPEND
                        if (
                            data.p === "response/fragments" &&
                            data.o === "APPEND" &&
                            Array.isArray(data.v)
                        ) {
                            for (const fragment of data.v) {
                                const idx = req.fragmentCount++;
                                if (fragment.type === "RESPONSE") {
                                    req.responseFragmentIndex = idx;
                                    req.currentFragmentIndex = idx;
                                    if (fragment.content)
                                        req.chunks.push(fragment.content);
                                } else {
                                    req.currentFragmentIndex = idx;
                                }
                            }
                        }

                        // BATCH operations
                        if (
                            data.o === "BATCH" &&
                            data.p === "response" &&
                            Array.isArray(data.v)
                        ) {
                            for (const item of data.v) {
                                if (
                                    item.p === "fragments" &&
                                    item.o === "APPEND" &&
                                    Array.isArray(item.v)
                                ) {
                                    for (const fragment of item.v) {
                                        const idx = req.fragmentCount++;
                                        if (fragment.type === "RESPONSE") {
                                            req.responseFragmentIndex = idx;
                                            req.currentFragmentIndex = idx;
                                            if (fragment.content)
                                                req.chunks.push(
                                                    fragment.content,
                                                );
                                        } else {
                                            req.currentFragmentIndex = idx;
                                        }
                                    }
                                }
                                if (
                                    item.p === "status" &&
                                    item.v === "FINISHED"
                                ) {
                                    req.complete = true;
                                }
                            }
                        }
                    } catch {}
                }
            };

            if (!window.__deepseekIntercepted) {
                window.__deepseekIntercepted = true;

                // Intercept XMLHttpRequest
                const originalXHROpen = XMLHttpRequest.prototype.open;
                const originalXHRSend = XMLHttpRequest.prototype.send;

                XMLHttpRequest.prototype.open = function (
                    method,
                    url,
                    ...rest
                ) {
                    this._url = url;
                    this._method = method;
                    return originalXHROpen.call(this, method, url, ...rest);
                };

                XMLHttpRequest.prototype.send = function (body) {
                    const url = this._url || "";

                    if (
                        url.includes("chat") &&
                        (url.includes("completion") || url.includes("message"))
                    ) {
                        const activeReqId = Object.keys(
                            window.__deepseekRequests || {},
                        ).find((id) => window.__deepseekRequests[id]?.active);

                        if (activeReqId) {
                            const req = window.__deepseekRequests[activeReqId];
                            req.debug.push(`XHR: ${url.substring(0, 100)}`);

                            let lastIndex = 0;
                            this.addEventListener("progress", () => {
                                const text =
                                    this.responseText.substring(lastIndex);
                                lastIndex = this.responseText.length;
                                if (text) parseSSEData(text, req);
                            });

                            this.addEventListener("load", () => {
                                const text =
                                    this.responseText.substring(lastIndex);
                                if (text) parseSSEData(text, req);
                                req.complete = true;
                            });

                            this.addEventListener("error", () => {
                                req.error = "XHR error";
                                req.complete = true;
                            });
                        }
                    }

                    return originalXHRSend.call(this, body);
                };

                // Intercept fetch
                const originalFetch = window.fetch;
                window.fetch = async function (...args) {
                    const response = await originalFetch.apply(this, args);
                    const url = args[0]?.toString?.() || args[0]?.url || "";

                    const activeReqId = Object.keys(
                        window.__deepseekRequests || {},
                    ).find((id) => window.__deepseekRequests[id]?.active);

                    if (activeReqId && window.__deepseekRequests[activeReqId]) {
                        window.__deepseekRequests[activeReqId].debug.push(
                            `fetch: ${url.substring(0, 80)}`,
                        );
                    }

                    if (
                        url.includes("chat") &&
                        (url.includes("completion") || url.includes("message"))
                    ) {
                        const clone = response.clone();
                        const reader = clone.body?.getReader();

                        if (reader && activeReqId) {
                            const req = window.__deepseekRequests[activeReqId];
                            const decoder = new TextDecoder();

                            (async () => {
                                try {
                                    while (true) {
                                        const { done, value } =
                                            await reader.read();
                                        if (done) {
                                            req.complete = true;
                                            break;
                                        }
                                        const text = decoder.decode(value, {
                                            stream: true,
                                        });
                                        parseSSEData(text, req);
                                    }
                                } catch (e) {
                                    req.error = e.message;
                                    req.complete = true;
                                }
                            })();
                        }
                    }
                    return response;
                };

                // Intercept EventSource
                const OriginalEventSource = window.EventSource;
                window.EventSource = function (url, config) {
                    const es = new OriginalEventSource(url, config);

                    const activeReqId = Object.keys(
                        window.__deepseekRequests || {},
                    ).find((id) => window.__deepseekRequests[id]?.active);

                    if (activeReqId) {
                        const req = window.__deepseekRequests[activeReqId];
                        req.debug.push(`EventSource: ${url.substring(0, 80)}`);

                        es.addEventListener("message", (event) => {
                            if (event.data) {
                                parseSSEData(`data: ${event.data}`, req);
                            }
                        });

                        es.addEventListener("error", () => {
                            req.complete = true;
                        });
                    }

                    return es;
                };
            }
        }, requestId);

        // Wait for input
        await page.waitForSelector("textarea", { timeout: 60000 });
        await sleep(500, 1000);

        // Configure model options (DeepThink, Search)
        const thinking = modelId.includes("thinking");
        const search = modelId.includes("search");

        // Try both English and French button names
        const thinkingClicked =
            (await toggleButton(page, "DeepThink", thinking)) ||
            (await toggleButton(page, "Pensée profonde", thinking));
        await sleep(200, 400);
        const searchClicked =
            (await toggleButton(page, "Search", search)) ||
            (await toggleButton(page, "Rechercher", search));
        await sleep(200, 400);

        log(
            "INFO",
            `Toggle buttons: thinking=${thinking} (clicked=${thinkingClicked}), search=${search} (clicked=${searchClicked})`,
        );

        // Type prompt using paste
        await page.click("textarea");
        await sleep(200, 300);
        await pasteText(page, "textarea", prompt);
        await sleep(500, 1000);

        // Send message
        await page.keyboard.press("Enter");
        log("INFO", "Message sent, polling for SSE chunks...");

        // Poll for chunks
        let fullResponse = "";
        let lastChunkCount = 0;
        let stableCount = 0;
        const startTime = Date.now();
        const timeout = 300000; // 5 minutes

        while (Date.now() - startTime < timeout) {
            await sleep(100);

            const result = await page.evaluate((reqId) => {
                const req = window.__deepseekRequests?.[reqId];
                if (!req)
                    return {
                        chunks: [],
                        complete: false,
                        error: "Request not found",
                        debug: [],
                    };
                return {
                    chunks: req.chunks || [],
                    complete: req.complete || false,
                    error: req.error,
                    debug: req.debug || [],
                };
            }, requestId);

            // Log debug info periodically
            if (stableCount === 0 && result.debug?.length > 0) {
                log("DEBUG", "Intercepted URLs", {
                    urls: result.debug.slice(-5),
                });
            }

            if (result.error && result.error !== "Request not found") {
                log("WARN", "SSE error", { error: result.error });
            }

            // Send new chunks
            if (result.chunks.length > lastChunkCount) {
                const newChunks = result.chunks.slice(lastChunkCount);
                for (const chunk of newChunks) {
                    fullResponse += chunk;
                    if (isStreaming && onChunk) {
                        onChunk(chunk);
                    }
                }
                lastChunkCount = result.chunks.length;
                stableCount = 0;
            } else if (fullResponse.length > 0) {
                stableCount++;
            }

            // Check if complete (only trust complete flag, not stability)
            if (result.complete && fullResponse.length > 0) {
                log("INFO", "SSE stream complete");
                break;
            }

            // Fallback: timeout if stable for 30 seconds (300 iterations × 100ms)
            if (stableCount > 300 && fullResponse.length > 0) {
                log("INFO", "Response stable for 30s, assuming complete");
                break;
            }
        }

        // Cleanup request
        await page.evaluate((reqId) => {
            if (window.__deepseekRequests?.[reqId]) {
                window.__deepseekRequests[reqId].active = false;
                setTimeout(() => {
                    delete window.__deepseekRequests[reqId];
                }, 5000);
            }
        }, requestId);

        if (!fullResponse?.trim()) {
            throw new Error("Empty response - no SSE chunks received");
        }

        log(
            "INFO",
            `Page ${pageObj.id} generated ${fullResponse.length} chars`,
        );
        return fullResponse.trim();
    } finally {
        releasePage(pageObj);
    }
}

// ==================== HTTP Server ====================
const MODELS = [
    { id: "deepseek-v3.2", name: "DeepSeek V3.2" },
    { id: "deepseek-v3.2-thinking", name: "DeepSeek V3.2 (Thinking)" },
    { id: "deepseek-v3.2-search", name: "DeepSeek V3.2 (Search)" },
    {
        id: "deepseek-v3.2-thinking-search",
        name: "DeepSeek V3.2 (Thinking + Search)",
    },
];

function sendJson(res, status, data) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
}

function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch {
                reject(new Error("Invalid JSON"));
            }
        });
        req.on("error", reject);
    });
}

function checkAuth(req) {
    const auth = req.headers.authorization;
    if (!auth) return false;
    const token = auth.replace("Bearer ", "");
    return token === AUTH_TOKEN;
}

async function handleRequest(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization",
    );

    if (req.method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // Health check
    if (pathname === "/health") {
        return sendJson(res, 200, {
            status: "ok",
            browser: !!browser,
            totalPages: pagePool.length,
            busyPages: pagePool.filter((p) => p.busy).length,
            maxPages: MAX_PAGES,
        });
    }

    // Models list
    if (pathname === "/v1/models" && req.method === "GET") {
        if (!checkAuth(req))
            return sendJson(res, 401, { error: "Unauthorized" });
        return sendJson(res, 200, {
            object: "list",
            data: MODELS.map((m) => ({
                id: m.id,
                object: "model",
                created: Date.now(),
                owned_by: "deepseek",
            })),
        });
    }

    // Chat completions
    if (pathname === "/v1/chat/completions" && req.method === "POST") {
        if (!checkAuth(req))
            return sendJson(res, 401, { error: "Unauthorized" });

        try {
            const body = await parseBody(req);
            const {
                model = "deepseek-v3.2",
                messages = [],
                stream = false,
            } = body;

            if (!messages.length) {
                return sendJson(res, 400, { error: "No messages provided" });
            }

            const prompt = buildPrompt(body);

            const responseId = `chatcmpl-${Date.now()}`;
            const created = Math.floor(Date.now() / 1000);

            const rawResponse = await generate(prompt, model);
            const { message, finishReason } = parseModelResponse(rawResponse);

            if (stream) {
                res.writeHead(200, {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    Connection: "keep-alive",
                });

                const chunkData = {
                    id: responseId,
                    object: "chat.completion.chunk",
                    created,
                    model,
                    choices: [
                        {
                            index: 0,
                            delta: message,
                            finish_reason: null,
                        },
                    ],
                };

                res.write(`data: ${JSON.stringify(chunkData)}\n\n`);

                const finishData = {
                    id: responseId,
                    object: "chat.completion.chunk",
                    created,
                    model,
                    choices: [
                        {
                            index: 0,
                            delta: {},
                            finish_reason: finishReason,
                        },
                    ],
                };

                res.write(`data: ${JSON.stringify(finishData)}\n\n`);
                res.write("data: [DONE]\n\n");

                return res.end();
            }

            return sendJson(res, 200, {
                id: responseId,
                object: "chat.completion",
                created,
                model,
                choices: [
                    {
                        index: 0,
                        message,
                        finish_reason: finishReason,
                    },
                ],
                usage: {
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    total_tokens: 0,
                },
            });
        } catch (e) {
            log("ERROR", "Generation failed", { error: e.message });
            return sendJson(res, 500, { error: e.message });
        }
    }
    sendJson(res, 404, { error: "Not found" });
}

// ==================== Main ====================
async function main() {
    await initBrowser();

    const server = http.createServer(handleRequest);
    server.listen(PORT, () => {
        log("INFO", `DeepSeek Server running on port ${PORT}`);
        log("INFO", `API Key: ${AUTH_TOKEN}`);
        log("INFO", "Endpoints:");
        log("INFO", "  GET  /health               - Health check");
        log("INFO", "  GET  /v1/models            - List models");
        log(
            "INFO",
            "  POST /v1/chat/completions  - Chat (stateless, each request = new chat)",
        );
    });

    process.on("SIGINT", async () => {
        log("INFO", "Shutting down...");
        if (context) await saveState();
        if (browser) await browser.close();
        process.exit(0);
    });
}

main().catch((e) => {
    log("ERROR", "Startup failed", { error: e.message });
    process.exit(1);
});
