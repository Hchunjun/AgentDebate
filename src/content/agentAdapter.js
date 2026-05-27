const PROVIDERS = globalThis.AgentDebateConfig?.providers || [];
const FRAME_MESSAGE_SOURCE = "agentdebate-frame-host";
const FRAME_RESPONSE_SOURCE = "agentdebate-frame";

function detectProvider() {
  return PROVIDERS.find((provider) => {
    const hosts = Array.isArray(provider.host) ? provider.host : [provider.host];
    return hosts.some((host) => location.host === host || location.host.endsWith(`.${host}`));
  }) || null;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.source !== "agentdebate") return false;

  handleAgentDebateMessage(message)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({ ok: false, error: error.message || String(error) });
    });

  return true;
});

window.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.source !== FRAME_MESSAGE_SOURCE || !data.requestId || !data.message) return;

  const target = event.source;
  if (!target) return;

  const targetOrigin = event.origin && event.origin !== "null" ? event.origin : "*";

  handleAgentDebateMessage(data.message)
    .then((response) => {
      target.postMessage({
        source: FRAME_RESPONSE_SOURCE,
        requestId: data.requestId,
        ok: true,
        response
      }, targetOrigin);
    })
    .catch((error) => {
      target.postMessage({
        source: FRAME_RESPONSE_SOURCE,
        requestId: data.requestId,
        ok: false,
        error: error.message || String(error)
      }, targetOrigin);
    });
});

async function handleAgentDebateMessage(message) {
  const provider = detectProvider();

  if (message.type === "GET_AGENTDEBATE_SITE_STATUS") {
    return {
      ok: true,
      provider,
      siteState: provider ? getProviderPageState(provider) : null,
      url: location.href,
      title: document.title
    };
  }

  if (!provider) {
    throw new Error("当前页面不是已支持的 AI 站点");
  }

  if (message.type === "AGENTDEBATE_SEND_PROMPT") {
    const prompt = String(message.prompt || "").trim();
    if (!prompt) throw new Error("Prompt 不能为空");

    const previousAnswer = extractLatestAnswer(provider);
    await executeSiteHandler(prompt, provider.searchHandler);

    const answer = await waitForChangedAnswer(provider, previousAnswer, {
      timeoutMs: message.timeoutMs || 60000,
      stableMs: message.stableMs || provider.stableMs || 2600
    });

    return {
      ok: true,
      provider,
      answer: answer.text,
      answerHtml: answer.html,
      answerFormat: answer.html ? "html" : "text",
      url: location.href,
      title: document.title
    };
  }

  if (message.type === "AGENTDEBATE_FIRE_PROMPT") {
    const prompt = String(message.prompt || "").trim();
    if (!prompt) throw new Error("Prompt 不能为空");

    await executeSiteHandler(prompt, provider.searchHandler);

    return {
      ok: true,
      provider,
      url: location.href,
      title: document.title
    };
  }

  if (message.type === "AGENTDEBATE_EXTRACT_LATEST_ANSWER") {
    const answer = extractLatestAnswer(provider);
    return {
      ok: true,
      provider,
      answer: answer.text,
      answerHtml: answer.html,
      answerFormat: answer.html ? "html" : "text",
      debug: answer.debug || "",
      url: location.href,
      title: document.title
    };
  }

  throw new Error(`未知消息类型：${message.type}`);
}

function getProviderPageState(provider) {
  const canPrompt = hasPromptInput(provider);
  const loginRequired = !canPrompt && hasLoginSignal();

  return {
    canPrompt,
    loginRequired,
    state: loginRequired ? "login-required" : (canPrompt ? "ready" : "unknown")
  };
}

function hasPromptInput(provider) {
  const steps = provider.searchHandler?.steps || [];
  const inputSteps = steps.filter((step) => ["focus", "setValue", "sendKeys"].includes(step.action));

  return inputSteps.some((step) => getSelectorList(step.selector).some((selector) => {
    try {
      const element = queryOne(selector);
      return Boolean(element && isUsableElement(element));
    } catch (_error) {
      return false;
    }
  }));
}

function getSelectorList(selector) {
  if (Array.isArray(selector)) {
    return selector.flatMap((item) => getSelectorList(item));
  }

  return String(selector || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function isUsableElement(element) {
  if (!(element instanceof Element)) return false;
  if (element.closest("[hidden], [aria-hidden=\"true\"]")) return false;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLButtonElement) {
    if (element.disabled) return false;
  }

  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function hasLoginSignal() {
  if (document.querySelector("input[type=\"password\"]")) return true;

  const text = [
    document.title,
    ...Array.from(document.querySelectorAll("button, a, [role=\"button\"]"))
      .slice(0, 80)
      .map((element) => element.innerText || element.textContent || "")
  ].join("\n");

  return /登录|登陆|扫码登录|立即登录|未登录|请登录|log in|sign in|sign up/i.test(text);
}

async function executeSiteHandler(prompt, handlerConfig) {
  if (!handlerConfig?.steps?.length) {
    throw new Error("缺少站点执行配置");
  }

  for (const step of handlerConfig.steps) {
    if (step.action === "focus") {
      const element = await waitForElement(step);
      element.focus();
      continue;
    }

    if (step.action === "setValue") {
      const element = await waitForElement(step);
      setElementValue(element, prompt, step.inputType);
      continue;
    }

    if (step.action === "triggerEvents") {
      const element = await waitForElement(step);
      triggerEvents(element, step.events || ["input", "change"]);
      continue;
    }

    if (step.action === "click") {
      const element = await waitForElement(step);
      if (!element) continue;
      await clickElement(element, step);
      continue;
    }

    if (step.action === "sendKeys") {
      const element = await waitForElement(step);
      if (!element) continue;
      sendKeys(element, step.keys || "Enter", step);
      continue;
    }

    if (step.action === "wait") {
      await delay(step.duration || 0);
      continue;
    }

    throw new Error(`不支持的站点步骤：${step.action}`);
  }
}

async function waitForElement(step) {
  const selectors = getSelectorList(step.selector);
  if (!selectors.length) throw new Error("缺少 selector");

  const maxAttempts = step.maxAttempts || (step.waitForElement ? 10 : 1);
  const retryInterval = step.retryInterval || 200;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element) return element;
    }

    if (attempt < maxAttempts - 1) {
      await delay(retryInterval);
    }
  }

  if (step.optional) return null;
  throw new Error(`未找到元素：${selectors.join(", ")}`);
}

function setElementValue(element, value, inputType) {
  element.focus();

  if (element.isContentEditable) {
    setContentEditableValue(element, value);
    return;
  }

  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");

  if (descriptor?.set) {
    descriptor.set.call(element, value);
  } else {
    element.value = value;
  }

  triggerEvents(element, ["input", "change"]);
}

function setContentEditableValue(element, value) {
  const selection = window.getSelection();
  const range = document.createRange();

  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);

  let inserted = false;
  try {
    inserted = document.execCommand("insertText", false, value);
  } catch (_error) {
    inserted = false;
  }

  if (!inserted) {
    element.textContent = "";
    const paragraph = document.createElement("p");
    const span = document.createElement("span");
    span.setAttribute("data-lexical-text", "true");
    span.textContent = value;
    paragraph.appendChild(span);
    element.appendChild(paragraph);
  }

  triggerEvents(element, ["beforeinput", "input", "change"]);
}

function triggerEvents(element, events) {
  for (const eventName of events) {
    const event = eventName === "beforeinput" || eventName === "input"
      ? new InputEvent(eventName, { bubbles: true, cancelable: true, inputType: "insertText" })
      : new Event(eventName, { bubbles: true, cancelable: true });
    element.dispatchEvent(event);
  }
}

async function clickElement(element, step) {
  const maxAttempts = step.maxAttempts || 10;
  const retryInterval = step.retryInterval || 200;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (!element.disabled && element.getAttribute("aria-disabled") !== "true") {
      element.click();
      return;
    }

    await delay(retryInterval);
  }

  if (step.optional) return;
  throw new Error("发送按钮不可用");
}

function sendKeys(element, keys, step = {}) {
  const key = keys === "Enter" ? "Enter" : keys;
  const options = {
    key,
    code: key === "Enter" ? "Enter" : undefined,
    bubbles: true,
    cancelable: true
  };

  element.dispatchEvent(new KeyboardEvent("keydown", options));
  if (step.dispatchKeypress !== false) {
    element.dispatchEvent(new KeyboardEvent("keypress", options));
  }
  element.dispatchEvent(new KeyboardEvent("keyup", options));
}

async function waitForChangedAnswer(provider, previousAnswer, options) {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs;
  const stableMs = options.stableMs;
  const minActiveMs = Math.max(stableMs, 6000);
  let lastPayload = null;
  let lastKey = "";
  let lastChangedAt = Date.now();
  let firstSeenAt = null;

  while (Date.now() - startedAt < timeoutMs) {
    const payload = extractLatestAnswer(provider);
    const key = payload.key;

    if (key && key !== lastKey) {
      lastPayload = payload;
      lastKey = key;
      lastChangedAt = Date.now();
      if (!firstSeenAt && key !== previousAnswer.key) {
        firstSeenAt = Date.now();
      }
    }

    if (
      key && key !== previousAnswer.key
      && firstSeenAt && Date.now() - firstSeenAt >= minActiveMs
      && Date.now() - lastChangedAt >= stableMs
    ) {
      return payload;
    }

    await delay(600);
  }

  if (lastPayload && lastKey !== previousAnswer.key) return lastPayload;
  throw new Error("等待回答超时");
}

function extractLatestAnswer(provider) {
  const extractor = provider.contentExtractor || {};
  const latestVisible = extractLatestVisibleResponse(extractor.latestVisibleResponse, extractor.excludeSelectors || []);
  if (latestVisible.key) return latestVisible;

  const containers = extractor.messageContainer
    ? queryAll(extractor.messageContainer)
    : [];

  if (containers.length) {
    const latest = getTopLevelElements(containers).at(-1);
    if (!latest) return createEmptyAnswerPayload();
    const content = extractFromContainer(latest, extractor.contentSelectors || [], extractor.excludeSelectors || []);
    if (content.key) return content;
  }

  const selectors = [
    ...(extractor.selectors || []),
    ...(extractor.fallbackSelectors || [])
  ];

  for (const selector of selectors) {
    const matches = getTopLevelElements(queryAll(selector));
    const last = matches.at(-1);
    if (!last) continue;
    const content = createAnswerPayload(last, extractor.excludeSelectors || []);
    if (content.key) return content;
  }

  if (provider.id === "doubao") {
    const content = extractDoubaoAnswerFallback();
    if (content.key) return content;
  }

  return createEmptyAnswerPayload(createExtractorDebug(provider));
}

function extractLatestVisibleResponse(config, excludeSelectors) {
  if (!config?.messageSelector) return createEmptyAnswerPayload();

  const ignoredAncestorSelectors = [
    ...(config.ignoredAncestorSelectors || []),
    ...(excludeSelectors || [])
  ];
  const ignoredTextPatterns = (config.ignoredTextPatterns || [])
    .map((pattern) => {
      try {
        return new RegExp(pattern);
      } catch (_error) {
        return null;
      }
    })
    .filter(Boolean);

  const candidates = getTopLevelElements(queryAll(config.messageSelector))
    .filter((element) => {
      if (!isVisibleElement(element)) return false;
      if (ignoredAncestorSelectors.some((selector) => safeClosest(element, selector))) return false;
      const text = normalizeText(element.innerText || element.textContent || "");
      if (!text || ignoredTextPatterns.some((pattern) => pattern.test(text))) return false;
      return true;
    });

  const latest = candidates.at(-1);
  return latest ? createAnswerPayload(latest, excludeSelectors) : createEmptyAnswerPayload();
}

function getTopLevelElements(elements) {
  const set = new Set(elements);
  return elements.filter((element) => {
    let parent = element.parentElement;
    while (parent) {
      if (set.has(parent)) return false;
      parent = parent.parentElement;
    }
    return true;
  });
}

function extractFromContainer(container, selectors, excludeSelectors = []) {
  for (const selector of selectors) {
    const matches = queryAll(selector, container);
    if (!matches.length) continue;
    const content = createAnswerPayload(matches, excludeSelectors);
    if (content.key) return content;
  }

  return createAnswerPayload(container, excludeSelectors);
}

function normalizeText(value) {
  return String(value || "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function createEmptyAnswerPayload(debug = "") {
  return { text: "", html: "", key: "", debug };
}

function createAnswerPayload(input, excludeSelectors = []) {
  const elements = Array.isArray(input) ? input : [input];
  const text = normalizeText(elements.map((element) => getElementText(element, excludeSelectors)).join("\n\n"));
  const html = normalizeHtml(elements.map(elementToSafeHtml).filter(Boolean).join("\n\n"));

  return {
    text,
    html,
    key: text
  };
}

function getElementText(element, excludeSelectors = []) {
  if (!excludeSelectors.length) return element.innerText || element.textContent || "";

  const clone = element.cloneNode(true);
  for (const selector of excludeSelectors) {
    for (const match of queryAll(selector, clone)) {
      match.remove();
    }
  }
  return clone.innerText || clone.textContent || "";
}

function extractDoubaoAnswerFallback() {
  const selectors = [
    ".inner-item-w21SQO [class*=\"flow-markdown-body\"]",
    ".inner-item-w21SQO [class*=\"markdown-body\"]",
    "[data-testid=\"message_text_content\"]",
    "[data-testid*=\"message_text\"]",
    "[data-testid*=\"message-content\"]",
    "[data-testid*=\"message_content\"]",
    "[class*=\"message_text_content\"]",
    "[class*=\"message-content\"]",
    "[class*=\"messageContent\"]",
    "[class*=\"MessageContent\"]",
    "[class*=\"md-box-root\"]",
    "[class*=\"answer-content\"]",
    "[class*=\"AnswerContent\"]",
    "[class*=\"markdown\"]",
    "[class*=\"Markdown\"]",
    "[class*=\"receive\"]"
  ];
  const elements = selectors.flatMap((selector) => queryAll(selector));
  const seen = new Set();
  const candidates = getTopLevelElements(elements)
    .filter((element) => {
      if (seen.has(element)) return false;
      seen.add(element);
      return isLikelyAnswerElement(element);
    });

  const latest = candidates.at(-1);
  return latest ? createAnswerPayload(latest) : createEmptyAnswerPayload(createExtractorDebug({ id: "doubao" }));
}

function isLikelyAnswerElement(element) {
  if (!element || !(element instanceof Element)) return false;
  if (element.closest("textarea, input, form, nav, aside, footer, [contenteditable=\"true\"]")) return false;
  if (element.closest("[data-testid*=\"chat_input\"], [data-testid*=\"send\"], [class*=\"chat-input\"], [class*=\"chat_input\"], [class*=\"suggest\"], [class*=\"Suggest\"]")) return false;
  const text = normalizeText(element.innerText || element.textContent || "");
  if (text.length < 8) return false;
  if (/^(复制|重新生成|点赞|点踩|分享|编辑|发送|停止生成)$/.test(text)) return false;
  return true;
}

function createExtractorDebug(provider) {
  if (provider.id !== "doubao") return "";

  const selectors = [
    "[data-testid=\"receive_message\"]",
    "[data-testid=\"message_block_receive\"]",
    "[data-testid=\"message_text_content\"]",
    "[data-testid*=\"message_text\"]",
    ".inner-item-w21SQO",
    "[class*=\"flow-markdown-body\"]",
    "[class*=\"markdown-body\"]",
    "[class*=\"receive\"]",
    "[class*=\"markdown\"]"
  ];

  return selectors
    .map((selector) => `${selector}: ${queryAll(selector).length}`)
    .join("; ");
}

function queryOne(selector, root = document) {
  try {
    return root.querySelector(selector);
  } catch (_error) {
    return null;
  }
}

function queryAll(selector, root = document) {
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch (_error) {
    return [];
  }
}

function safeClosest(element, selector) {
  try {
    return element.closest(selector);
  } catch (_error) {
    return null;
  }
}

function isVisibleElement(element) {
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function normalizeHtml(value) {
  return String(value || "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "BUTTON", "INPUT", "TEXTAREA", "SELECT"]);
const INLINE_TAGS = new Set(["A", "STRONG", "B", "EM", "I", "DEL", "S", "STRIKE", "CODE", "SPAN"]);
const BLOCK_TAGS = new Set(["P", "DIV", "SECTION", "ARTICLE"]);
const STRUCTURAL_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6", "BR", "HR", "PRE", "BLOCKQUOTE", "UL", "OL", "LI", "TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TH", "TD"]);

function elementToSafeHtml(root) {
  if (!root) return "";
  return sanitizeNode(root);
}

function sanitizeNode(node) {
  if (!node) return "";

  if (node.nodeType === Node.TEXT_NODE) {
    return escapeHtml(node.textContent || "");
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return "";

  const tag = node.tagName.toUpperCase();
  if (SKIP_TAGS.has(tag)) return "";

  if (tag === "A") {
    const href = node.getAttribute("href") || "";
    const body = sanitizeChildren(node);
    if (!body) return "";
    if (/^https?:/i.test(href)) {
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${body}</a>`;
    }
    return body;
  }

  if (tag === "BR") return "<br>";
  if (tag === "HR") return "<hr>";

  if (tag === "PRE") {
    const code = node.querySelector("code");
    const text = (code || node).innerText || (code || node).textContent || "";
    return `<pre><code>${escapeHtml(text.replace(/\n+$/, ""))}</code></pre>`;
  }

  const normalizedTag = getNormalizedTag(tag);
  const body = sanitizeChildren(node);

  if (normalizedTag) {
    return `<${normalizedTag}>${body}</${normalizedTag}>`;
  }

  if (INLINE_TAGS.has(tag) || BLOCK_TAGS.has(tag) || STRUCTURAL_TAGS.has(tag)) {
    return body;
  }

  return body;
}

function sanitizeChildren(element) {
  return Array.from(element.childNodes).map((child) => sanitizeNode(child)).join("");
}

function getNormalizedTag(tag) {
  if (/^H[1-6]$/.test(tag)) return tag.toLowerCase();
  if (tag === "P") return "p";
  if (tag === "STRONG" || tag === "B") return "strong";
  if (tag === "EM" || tag === "I") return "em";
  if (tag === "DEL" || tag === "S" || tag === "STRIKE") return "del";
  if (tag === "CODE") return "code";
  if (tag === "BLOCKQUOTE") return "blockquote";
  if (tag === "UL" || tag === "OL" || tag === "LI") return tag.toLowerCase();
  if (tag === "TABLE" || tag === "THEAD" || tag === "TBODY" || tag === "TFOOT" || tag === "TR" || tag === "TH" || tag === "TD") return tag.toLowerCase();
  return "";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
