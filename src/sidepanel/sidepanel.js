const PROVIDER_CONFIG = globalThis.AgentDebateConfig || { agents: [], providers: [] };
const FLOW_CONFIG = globalThis.AgentDebateFlowConfig || { debateFlows: [] };
const AGENTS = PROVIDER_CONFIG.agents;
const PROVIDER_HOSTS = Object.fromEntries(PROVIDER_CONFIG.providers.map((provider) => [
  provider.id,
  Array.isArray(provider.host) ? provider.host : [provider.host]
]));
const NEW_CHAT_URLS = Object.fromEntries(PROVIDER_CONFIG.providers.map((provider) => [
  provider.id,
  provider.newChatUrl
]));
const DEBATE_FLOWS = FLOW_CONFIG.debateFlows || [];
const DEFAULT_DEBATE_FLOW_ID = FLOW_CONFIG.defaultDebateFlowId || DEBATE_FLOWS[0]?.id || "default";
const FALLBACK_DEBATE_FLOW = { id: "default", name: "默认辩论", roles: [] };
let activeDebateFlow = getDebateFlowById(DEFAULT_DEBATE_FLOW_ID);
let activeDebateRoles = activeDebateFlow.roles || [];

const state = {
  messages: [],
  debateFlowId: activeDebateFlow.id,
  roleAssignmentsByFlow: {
    [activeDebateFlow.id]: getDefaultRoleAssignments(activeDebateFlow)
  },
  promptDraft: "",
  runId: 0,
  isRunning: false
};

const thread = document.querySelector("#thread");
const composer = document.querySelector("#composer");
const promptInput = document.querySelector("#promptInput");
const clearButton = document.querySelector("#clearButton");
const submitButton = composer.querySelector(".primary-button");
const agentsList = document.querySelector("#agentsList");
const flowPicker = document.querySelector("#flowPicker");
const debateFlowSelect = document.querySelector("#debateFlowSelect");
const roleAssignments = document.querySelector("#roleAssignments");
const agentFrameHost = document.querySelector("#agentFrameHost");
const storage = getStorage();
const FRAME_MESSAGE_SOURCE = "agentdebate-frame-host";
const FRAME_RESPONSE_SOURCE = "agentdebate-frame";
const IFRAME_UNSTABLE_AGENTS = new Set(["gpt"]);
let frameMessageSeq = 0;
const pendingFrameMessages = new Map();
const lastAgentTargets = new Map();

function getDebateFlowById(flowId) {
  return DEBATE_FLOWS.find((flow) => flow.id === flowId) || DEBATE_FLOWS[0] || FALLBACK_DEBATE_FLOW;
}

function setActiveDebateFlow(flowId) {
  activeDebateFlow = getDebateFlowById(flowId);
  activeDebateRoles = activeDebateFlow.roles || [];
  state.debateFlowId = activeDebateFlow.id;
  ensureRoleAssignmentsForFlow(activeDebateFlow);
}

function getDefaultRoleAssignments(flow) {
  return Object.fromEntries((flow.roles || []).map((role) => [role.id, role.defaultAgentId]));
}

function ensureRoleAssignmentsForFlow(flow) {
  if (!state.roleAssignmentsByFlow[flow.id]) {
    state.roleAssignmentsByFlow[flow.id] = getDefaultRoleAssignments(flow);
    return;
  }

  state.roleAssignmentsByFlow[flow.id] = mergeRoleValues(
    getDefaultRoleAssignments(flow),
    state.roleAssignmentsByFlow[flow.id],
    flow.roles || []
  );
}

function getCurrentRoleAssignments() {
  ensureRoleAssignmentsForFlow(activeDebateFlow);
  return state.roleAssignmentsByFlow[activeDebateFlow.id];
}

function restoreRoleAssignmentsByFlow(savedState) {
  const restored = {};
  const savedByFlow = savedState.roleAssignmentsByFlow || {};

  for (const flow of DEBATE_FLOWS) {
    restored[flow.id] = mergeRoleValues(
      getDefaultRoleAssignments(flow),
      savedByFlow[flow.id],
      flow.roles || []
    );
  }

  if (!savedState.roleAssignmentsByFlow && savedState.roleAssignments) {
    restored[activeDebateFlow.id] = mergeRoleValues(
      getDefaultRoleAssignments(activeDebateFlow),
      savedState.roleAssignments,
      activeDebateRoles
    );
  }

  return restored;
}

function getStorage() {
  if (globalThis.chrome?.storage?.local) {
    return globalThis.chrome.storage.local;
  }

  return {
    async get(key) {
      const raw = localStorage.getItem(key);
      return raw ? { [key]: JSON.parse(raw) } : {};
    },
    async set(values) {
      for (const [key, value] of Object.entries(values)) {
        localStorage.setItem(key, JSON.stringify(value));
      }
    }
  };
}

function createMessage({ speaker, speakerId, mark, round, content, htmlContent, roleTitle }) {
  return {
    id: crypto.randomUUID(),
    speaker,
    speakerId,
    mark,
    round,
    roleTitle,
    content,
    htmlContent: htmlContent || "",
    createdAt: Date.now()
  };
}

function render() {
  if (!state.messages.length) {
    thread.innerHTML = '<div class="empty-state">输入辩题后开始辩论</div>';
    return;
  }

  thread.innerHTML = state.messages.map((message) => {
    const type = message.speakerId || "moderator";
    const tone = getMessageTone(message);
    const roleClass = getRoleClass(message);
    const isPending = isMessagePending(message);
    const pendingClass = isPending ? " is-pending" : "";
    const mark = message.mark ? escapeHtml(message.mark) : "";
    const badge = mark ? `<span class="speaker-badge">${mark}</span>` : "";
    const title = message.roleTitle || message.round || message.speaker;
    const meta = message.roleTitle ? message.speaker : message.round;
    const body = isPending
      ? `<div class="thinking-indicator" role="status" aria-label="思考中">
          <span class="thinking-dot"></span><span class="thinking-dot"></span><span class="thinking-dot"></span>
          <span class="thinking-label">思考中…</span>
        </div>`
      : renderMessageBody(message);
    return `
      <article class="message ${type} ${tone} ${roleClass}${pendingClass}">
        <div class="message-header">
          <div class="speaker">
            ${badge}
            <span class="speaker-title">${escapeHtml(title)}</span>
            ${meta ? `<span class="speaker-meta">${escapeHtml(meta)}</span>` : ""}
            ${isPending ? '<span class="status-pulse" aria-hidden="true"></span>' : ""}
          </div>
          <span class="round-tag">${escapeHtml(message.roleTitle ? "" : message.round || "")}</span>
        </div>
        <div class="message-body markdown-body">${body}</div>
      </article>
    `;
  }).join("");

  thread.scrollTop = thread.scrollHeight;
}

function renderMessageBody(message) {
  if (message.htmlContent) return sanitizeHtml(message.htmlContent);
  return renderMarkdown(message.content);
}

function getRoleClass(message) {
  if (!message.roleTitle) return "";
  const role = activeDebateRoles.find((item) => item.title === message.roleTitle);
  if (!role) return "";
  return `role-${role.id}`;
}

function getMessageTone(message) {
  if (message.round === "辩题") return "is-topic";
  if (message.round === "裁判" || message.roleTitle === "裁判") return "is-judge";
  if (String(message.content || "").startsWith("本轮未完成：")) return "is-error";
  if (message.speakerId === "moderator") return "is-note";
  return "is-turn";
}

function isMessagePending(message) {
  if (!message || !message.speakerId) return false;
  if (message.speakerId === "user" || message.speakerId === "moderator") return false;
  return !String(message.content || "").trim();
}

function renderFlowSelector() {
  if (!flowPicker || !debateFlowSelect) return;

  if (DEBATE_FLOWS.length <= 1) {
    flowPicker.classList.add("hidden");
    return;
  }

  flowPicker.classList.remove("hidden");
  debateFlowSelect.innerHTML = DEBATE_FLOWS.map((flow) => `
    <option value="${escapeHtml(flow.id)}"${flow.id === activeDebateFlow.id ? " selected" : ""}>
      ${escapeHtml(flow.name || flow.id)}
    </option>
  `).join("");
}

function renderAgentList() {
  if (!agentsList) return;

  agentsList.innerHTML = AGENTS.map((agent) => `
    <div class="agent" data-agent="${escapeHtml(agent.id)}">
      <span class="agent-mark">${escapeHtml(agent.mark || agent.name.slice(0, 1))}</span>
      <span>
        <strong>${escapeHtml(agent.name)}</strong>
        <small>就绪</small>
      </span>
    </div>
  `).join("");
}

function renderRoleAssignments() {
  const currentAssignments = getCurrentRoleAssignments();
  roleAssignments.innerHTML = activeDebateRoles.map((role) => `
    <section class="role-field">
      <div class="role-field-header">
        <span>${escapeHtml(role.title)}</span>
      </div>
      <select data-role="${escapeHtml(role.id)}">
        ${AGENTS.map((agent) => `
          <option value="${escapeHtml(agent.id)}"${currentAssignments[role.id] === agent.id ? " selected" : ""}>
            ${escapeHtml(agent.name)}
          </option>
        `).join("")}
      </select>
    </section>
  `).join("");

  roleAssignments.querySelectorAll("select").forEach((select) => {
    select.addEventListener("change", () => {
      getCurrentRoleAssignments()[select.dataset.role] = select.value;
      persist();
    });
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const ALLOWED_HTML_TAGS = new Set([
  "A", "BLOCKQUOTE", "BR", "CODE", "DEL", "EM", "H1", "H2", "H3", "H4", "H5", "H6",
  "HR", "LI", "OL", "P", "PRE", "STRONG", "TABLE", "TBODY", "TD", "TFOOT", "TH",
  "THEAD", "TR", "UL"
]);
const BLOCKED_HTML_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "IFRAME", "OBJECT", "EMBED"]);

function sanitizeHtml(value) {
  const template = document.createElement("template");
  template.innerHTML = String(value || "");
  sanitizeHtmlChildren(template.content);
  return template.innerHTML;
}

function sanitizeHtmlChildren(parent) {
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) continue;
    if (node.nodeType !== Node.ELEMENT_NODE) {
      node.remove();
      continue;
    }

    sanitizeHtmlElement(node);
  }
}

function sanitizeHtmlElement(element) {
  const tag = element.tagName.toUpperCase();

  if (!ALLOWED_HTML_TAGS.has(tag)) {
    if (BLOCKED_HTML_TAGS.has(tag)) {
      element.remove();
      return;
    }

    sanitizeHtmlChildren(element);
    const fragment = document.createDocumentFragment();
    while (element.firstChild) {
      fragment.appendChild(element.firstChild);
    }
    element.replaceWith(fragment);
    return;
  }

  const href = element.getAttribute("href") || "";
  for (const attr of Array.from(element.attributes)) {
    element.removeAttribute(attr.name);
  }

  if (tag === "A" && /^https?:/i.test(href)) {
    element.setAttribute("href", href);
    element.setAttribute("target", "_blank");
    element.setAttribute("rel", "noopener noreferrer");
  }

  sanitizeHtmlChildren(element);
}

// Minimal, safe markdown renderer. Input is escaped first so output is
// guaranteed XSS-safe; we then re-introduce only a small, fixed set of
// inline/block HTML tags.
function renderMarkdown(value) {
  const source = String(value || "");
  if (!source) return "";

  const escaped = escapeHtml(source);
  const lines = escaped.split("\n");
  const out = [];

  let inCode = false;
  let codeBuf = [];
  let listType = null; // "ul" | "ol"
  let listBuf = [];
  let paraBuf = [];
  let quoteBuf = [];

  const flushPara = () => {
    if (paraBuf.length) {
      out.push(`<p>${paraBuf.map(renderInline).join("<br>")}</p>`);
      paraBuf = [];
    }
  };

  const flushList = () => {
    if (listBuf.length) {
      const items = listBuf.map((item) => `<li>${renderInline(item)}</li>`).join("");
      out.push(`<${listType}>${items}</${listType}>`);
      listBuf = [];
      listType = null;
    }
  };

  const flushQuote = () => {
    if (quoteBuf.length) {
      out.push(`<blockquote>${quoteBuf.map(renderInline).join("<br>")}</blockquote>`);
      quoteBuf = [];
    }
  };

  const flushAll = () => {
    flushPara();
    flushList();
    flushQuote();
  };

  for (const line of lines) {
    const fence = line.match(/^\s*```/);
    if (fence) {
      if (inCode) {
        out.push(`<pre><code>${codeBuf.join("\n")}</code></pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        flushAll();
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      codeBuf.push(line);
      continue;
    }

    if (/^\s*(?:-\s*){3,}\s*$/.test(line) || /^\s*(?:\*\s*){3,}\s*$/.test(line) || /^\s*(?:_\s*){3,}\s*$/.test(line)) {
      flushAll();
      out.push("<hr>");
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    const quote = line.match(/^\s*&gt;\s?(.*)$/);
    if (quote) {
      flushPara();
      flushList();
      quoteBuf.push(quote[1]);
      continue;
    }

    const ul = line.match(/^\s*[-*+]\s+(.+)$/);
    if (ul) {
      flushPara();
      flushQuote();
      if (listType && listType !== "ul") flushList();
      listType = "ul";
      listBuf.push(ul[1]);
      continue;
    }

    const ol = line.match(/^\s*\d+\.\s+(.+)$/);
    if (ol) {
      flushPara();
      flushQuote();
      if (listType && listType !== "ol") flushList();
      listType = "ol";
      listBuf.push(ol[1]);
      continue;
    }

    if (line.trim() === "") {
      flushAll();
      continue;
    }

    flushList();
    flushQuote();
    paraBuf.push(line);
  }

  if (inCode) {
    out.push(`<pre><code>${codeBuf.join("\n")}</code></pre>`);
  }
  flushAll();

  return out.join("");
}

function renderInline(text) {
  return text
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getAgentFrame(agent) {
  if (!agentFrameHost) return null;
  return Array.from(agentFrameHost.querySelectorAll("iframe"))
    .find((frame) => frame.dataset.agent === agent.id) || null;
}

function createAgentFrame(agent) {
  if (!agentFrameHost) {
    throw new Error("缺少后台 iframe 容器");
  }

  const frame = document.createElement("iframe");
  frame.dataset.agent = agent.id;
  frame.title = `${agent.name} 后台会话`;
  frame.allow = "clipboard-read; clipboard-write; microphone; camera; geolocation; autoplay; fullscreen; picture-in-picture; storage-access; web-share";
  agentFrameHost.appendChild(frame);
  return frame;
}

function waitForFrameLoad(frame, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("后台页面加载超时"));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      frame.removeEventListener("load", onLoad);
    }

    function onLoad() {
      cleanup();
      resolve();
    }

    frame.addEventListener("load", onLoad);
  });
}

function sendFrameMessage(frame, message, timeoutMs = 10000) {
  if (!frame?.contentWindow) {
    return Promise.reject(new Error("后台页面尚未创建"));
  }

  const requestId = `frame-${Date.now()}-${++frameMessageSeq}`;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingFrameMessages.delete(requestId);
      reject(new Error("后台页面响应超时"));
    }, timeoutMs);

    pendingFrameMessages.set(requestId, {
      frame,
      resolve,
      reject,
      timeout
    });

    frame.contentWindow.postMessage({
      source: FRAME_MESSAGE_SOURCE,
      requestId,
      message
    }, "*");
  });
}

function handleAgentFrameMessage(event) {
  const data = event.data || {};
  if (data.source !== FRAME_RESPONSE_SOURCE || !data.requestId) return;

  const pending = pendingFrameMessages.get(data.requestId);
  if (!pending || pending.frame.contentWindow !== event.source) return;

  clearTimeout(pending.timeout);
  pendingFrameMessages.delete(data.requestId);

  if (data.ok) {
    pending.resolve(data.response);
    return;
  }

  pending.reject(new Error(data.error || "后台页面执行失败"));
}

async function waitForAgentFrameReady(frame, agent) {
  const startedAt = Date.now();
  let lastError = "";

  while (Date.now() - startedAt < 30000) {
    try {
      const status = await sendFrameMessage(frame, {
        source: "agentdebate",
        type: "GET_AGENTDEBATE_SITE_STATUS"
      }, 3000);

      if (status?.ok && status.provider?.id === agent.id) {
        if (status.siteState?.loginRequired) {
          throw new Error(`${agent.name} 未登录`);
        }

        return;
      }
    } catch (error) {
      if (/未登录/.test(error.message || "")) throw error;
      lastError = error.message || String(error);
    }

    await delay(700);
  }

  throw new Error(`${agent.name} 后台页面未就绪${lastError ? `：${lastError}` : ""}`);
}

async function getAgentFrameStatus(agent) {
  const frame = getAgentFrame(agent);
  if (!frame) return null;

  try {
    const status = await sendFrameMessage(frame, {
      source: "agentdebate",
      type: "GET_AGENTDEBATE_SITE_STATUS"
    }, 3000);

    if (status?.ok && status.provider?.id === agent.id) {
      return status;
    }
  } catch (_error) {
    return null;
  }

  return null;
}

async function ensureAgentFrame(agent) {
  const newChatUrl = NEW_CHAT_URLS[agent.id];
  if (!newChatUrl) {
    throw new Error(`${agent.name} 无法自动打开`);
  }

  const frame = getAgentFrame(agent) || createAgentFrame(agent);
  const loadPromise = waitForFrameLoad(frame);
  frame.src = newChatUrl;
  await loadPromise;
  await delay(2000);
  await waitForAgentFrameReady(frame, agent);

  return { mode: "frame", frame };
}

function waitForTabLoad(tabId, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("页面加载超时"));
    }, timeoutMs);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, (tab) => {
      const error = chrome.runtime.lastError;
      if (error) return;
      if (tab?.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });
}

async function ensureAgentTab(agent) {
  if (!canUseLiveTabs()) {
    throw new Error("当前环境不支持访问 AI 标签页");
  }

  const newChatUrl = NEW_CHAT_URLS[agent.id];
  let tab = await findProviderTab(agent);

  if (tab?.id) {
    if (newChatUrl) {
      await chrome.tabs.update(tab.id, { url: newChatUrl });
      await waitForTabLoad(tab.id);
    }
  } else {
    if (!newChatUrl) {
      throw new Error(`${agent.name} 无法自动打开`);
    }

    tab = await chrome.tabs.create({ url: newChatUrl, active: false });
    await waitForTabLoad(tab.id);
  }

  const status = await getProviderStatusFromTab(tab);
  if (!status?.ok || status.provider?.id !== agent.id) {
    throw new Error(`${agent.name} 标签页未就绪`);
  }
  if (status.siteState?.loginRequired) {
    throw new Error(`${agent.name} 未登录，请先在该站点登录`);
  }
  if (status.siteState && !status.siteState.canPrompt) {
    throw new Error(`${agent.name} 页面暂时不可发送，请确认已进入对话页`);
  }

  return { mode: "tab", id: tab.id, tab };
}

async function ensureAgentTarget(agent) {
  if (IFRAME_UNSTABLE_AGENTS.has(agent.id)) {
    const target = await ensureAgentTab(agent);
    rememberAgentTarget(agent, target);
    return target;
  }

  try {
    const target = await ensureAgentFrame(agent);
    rememberAgentTarget(agent, target);
    return target;
  } catch (_frameError) {
    const target = await ensureAgentTab(agent);
    rememberAgentTarget(agent, target);
    return target;
  }
}

function rememberAgentTarget(agent, target) {
  if (!agent?.id || !target?.mode) return;
  lastAgentTargets.set(agent.id, target);
}

async function sendAgentMessage(target, message, timeoutMs) {
  if (target?.mode === "frame") {
    return sendFrameMessage(target.frame, message, timeoutMs);
  }

  return sendTabMessage(target.id, message);
}

function mergeRoleValues(defaults, savedValues, roles = activeDebateRoles) {
  const merged = { ...defaults };
  if (!savedValues || typeof savedValues !== "object") return merged;

  for (const role of roles) {
    if (Object.prototype.hasOwnProperty.call(savedValues, role.id)) {
      merged[role.id] = savedValues[role.id];
    }
  }

  return merged;
}

function hostMatchesProvider(tabUrl, agent) {
  try {
    const host = new URL(tabUrl).host;
    return (PROVIDER_HOSTS[agent.id] || []).some((providerHost) => (
      host === providerHost || host.endsWith(`.${providerHost}`)
    ));
  } catch (_error) {
    return false;
  }
}

function canUseLiveTabs() {
  return Boolean(globalThis.chrome?.tabs?.query && globalThis.chrome?.tabs?.sendMessage);
}

function canInjectContentScript() {
  return Boolean(globalThis.chrome?.scripting?.executeScript);
}

function shouldInjectAfterMessageError(error) {
  return /Could not establish connection|Receiving end does not exist/i.test(error.message || "");
}

async function queryTabs(queryInfo) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query(queryInfo, (tabs) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(tabs || []);
    });
  });
}

async function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });
}

async function injectAgentAdapter(tabId) {
  if (!canInjectContentScript()) {
    throw new Error("缺少 scripting 权限，无法注入 adapter");
  }

  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/providerConfig.js", "src/content/agentAdapter.js"]
    }, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

async function getProviderStatusFromTab(tab) {
  try {
    return await sendTabMessage(tab.id, {
      source: "agentdebate",
      type: "GET_AGENTDEBATE_SITE_STATUS"
    });
  } catch (error) {
    if (!shouldInjectAfterMessageError(error)) throw error;

    await injectAgentAdapter(tab.id);
    return sendTabMessage(tab.id, {
      source: "agentdebate",
      type: "GET_AGENTDEBATE_SITE_STATUS"
    });
  }
}

async function findProviderTab(agent) {
  if (!canUseLiveTabs()) return null;

  const tabs = await queryTabs({});
  const candidates = tabs.filter((tab) => hostMatchesProvider(tab.url, agent));

  for (const tab of candidates) {
    if (!tab.id) continue;

    try {
      const status = await getProviderStatusFromTab(tab);
      if (status?.ok && status.provider?.id === agent.id) {
        tab.agentDebateStatus = status;
        return tab;
      }
    } catch (_error) {
      // Some matching tabs may not be injectable or ready yet.
    }
  }

  return null;
}

async function refreshProviderStatuses() {
  const statuses = await Promise.all(AGENTS.map(async (agent) => {
    if (!canUseLiveTabs()) {
      return { agent, label: "本地环境", className: "is-local" };
    }

    try {
      const lastTarget = lastAgentTargets.get(agent.id);
      if (lastTarget?.mode === "tab" && lastTarget.id) {
        try {
          const status = await getProviderStatusFromTab({ id: lastTarget.id });
          if (status?.ok && status.provider?.id === agent.id) {
            if (status.siteState?.loginRequired) {
              return { agent, label: "未登录", className: "is-auth" };
            }

            return status.siteState && !status.siteState.canPrompt
              ? { agent, label: "不可发送", className: "is-missing" }
              : { agent, label: "标签页", className: "is-live" };
          }
        } catch (_error) {
          lastAgentTargets.delete(agent.id);
        }
      }

      let hasBrokenFrame = false;
      if (!IFRAME_UNSTABLE_AGENTS.has(agent.id) && getAgentFrame(agent)) {
        const frameStatus = await getAgentFrameStatus(agent);
        if (frameStatus?.siteState?.loginRequired) {
          return { agent, label: "未登录", className: "is-auth" };
        }

        if (frameStatus?.siteState?.canPrompt) {
          return { agent, label: "后台", className: "is-live" };
        }

        hasBrokenFrame = true;
      }

      const tab = await findProviderTab(agent);
      if (!tab) {
        if (hasBrokenFrame) {
          return { agent, label: "后台异常", className: "is-missing" };
        }
        return { agent, label: "未连接", className: "is-local" };
      }

      if (tab.agentDebateStatus?.siteState?.loginRequired) {
        return { agent, label: "未登录", className: "is-auth" };
      }

      return tab.agentDebateStatus?.siteState && !tab.agentDebateStatus.siteState.canPrompt
        ? { agent, label: "不可发送", className: "is-missing" }
        : { agent, label: "已连接", className: "is-live" };
    } catch (_error) {
      return { agent, label: "不可用", className: "is-missing" };
    }
  }));

  for (const { agent, label, className } of statuses) {
    const item = document.querySelector(`.agent[data-agent="${agent.id}"]`);
    if (!item) continue;

    item.classList.remove("is-live", "is-local", "is-missing", "is-auth");
    item.classList.add(className);
    item.querySelector("small").textContent = label;
  }
}

async function firePrompt(target, agent, prompt) {
  const response = await sendAgentMessage(target, {
    source: "agentdebate",
    type: "AGENTDEBATE_FIRE_PROMPT",
    agentId: agent.id,
    prompt
  }, 15000);

  if (!response?.ok) {
    throw new Error(response?.error || `${agent.name} prompt 发送失败`);
  }
}

async function getLatestAnswer(target) {
  try {
    const response = await sendAgentMessage(target, {
      source: "agentdebate",
      type: "AGENTDEBATE_EXTRACT_LATEST_ANSWER"
    }, 15000);
    return {
      content: response?.answer || "",
      htmlContent: response?.answerHtml || "",
      key: response?.answer || "",
      debug: response?.debug || ""
    };
  } catch (error) {
    return {
      content: "",
      htmlContent: "",
      key: "",
      debug: "",
      error: error.message || String(error)
    };
  }
}

function isCurrentRun(runId) {
  return state.isRunning && state.runId === runId;
}

async function runDebate(topic, runId) {
  if (!isCurrentRun(runId)) return;

  state.messages.push(createMessage({
    speaker: "我",
    speakerId: "user",
    mark: "",
    round: "辩题",
    content: topic
  }));
  render();
  await persist();

  const transcript = [];

  for (const role of activeDebateRoles) {
    if (!isCurrentRun(runId)) return;

    const agent = getAgentById(getCurrentRoleAssignments()[role.id]);
    if (!agent) {
      addSystemMessage(`辩论已中止：${role.title} 未配置 Agent。`);
      render();
      await persist();
      return;
    }

    const prompt = buildDebatePrompt({
      topic,
      role,
      agent,
      transcript
    });

    state.messages.push(createMessage({
      speaker: agent.name,
      speakerId: agent.id,
      mark: agent.mark,
      round: role.title,
      roleTitle: role.title,
      content: ""
    }));
    render();

    const messageIndex = state.messages.length - 1;
    const result = await requestDebateTurn(agent, prompt, messageIndex, runId);
    if (!isCurrentRun(runId)) return;

    state.messages[messageIndex].content = result.content;
    state.messages[messageIndex].htmlContent = result.htmlContent || "";
    render();
    await persist();

    if (!result.ok) {
      addSystemMessage(`辩论已中止：${role.title} 没有完成，后续轮次未执行。`);
      render();
      await persist();
      return;
    }

    transcript.push({
      role: role.title,
      speaker: agent.name,
      content: result.content
    });
  }
}

async function requestDebateTurn(agent, prompt, messageIndex, runId) {
  try {
    if (!isCurrentRun(runId)) {
      throw new Error("本轮已终止");
    }

    const target = await ensureAgentTarget(agent);
    if (!isCurrentRun(runId)) {
      throw new Error("本轮已终止");
    }

    const result = await requestDebateTurnWithTarget(agent, prompt, messageIndex, target, runId);
    if (result.ok || target.mode !== "frame") return result;

    const tabTarget = await ensureAgentTab(agent);
    rememberAgentTarget(agent, tabTarget);
    if (!isCurrentRun(runId)) {
      throw new Error("本轮已终止");
    }

    return requestDebateTurnWithTarget(agent, prompt, messageIndex, tabTarget, runId, result.content);
  } catch (error) {
    return { ok: false, content: `本轮未完成：${error.message}` };
  }
}

async function requestDebateTurnWithTarget(agent, prompt, messageIndex, target, runId, previousFailure = "") {
  try {
    if (!isCurrentRun(runId)) {
      throw new Error("本轮已终止");
    }

    const previousAnswer = await getLatestAnswer(target);

    if (!isCurrentRun(runId)) {
      throw new Error("本轮已终止");
    }

    await firePrompt(target, agent, prompt);

    let lastAnswer = { content: "", htmlContent: "", key: "", debug: "" };
    let lastDebug = "";
    let lastChangedAt = Date.now();
    let firstSeenAt = null;
    const startTime = Date.now();
    const timeoutMs = target.mode === "frame" ? 60000 : 120000;
    const stableMs = 6000;
    const minActiveMs = 10000;
    let readErrorCount = 0;

    while (Date.now() - startTime < timeoutMs) {
      if (!isCurrentRun(runId)) {
        throw new Error("本轮已终止");
      }

      await delay(1200);
      if (!isCurrentRun(runId)) {
        throw new Error("本轮已终止");
      }

      const answer = await getLatestAnswer(target);
      if (answer.error) {
        readErrorCount += 1;
        lastDebug = answer.error;
        if (target.mode === "frame" && readErrorCount >= 3) {
          throw new Error(`${agent.name} 后台读取失败：${answer.error}`);
        }
        continue;
      }

      if (answer.debug) lastDebug = answer.debug;

      if (answer.key && answer.key !== previousAnswer.key) {
        if (!firstSeenAt) firstSeenAt = Date.now();

        if (answer.key !== lastAnswer.key) {
          lastAnswer = answer;
          lastChangedAt = Date.now();
          if (isCurrentRun(runId)) {
            state.messages[messageIndex].content = answer.content;
            state.messages[messageIndex].htmlContent = answer.htmlContent;
            render();
          }
        }

        if (Date.now() - firstSeenAt >= minActiveMs && Date.now() - lastChangedAt >= stableMs) {
          return { ok: true, content: answer.content, htmlContent: answer.htmlContent };
        }
      }
    }

    if (lastAnswer.key) {
      return { ok: true, content: lastAnswer.content, htmlContent: lastAnswer.htmlContent };
    }
    const debugText = lastDebug ? `\n\n提取诊断：${lastDebug}` : "";
    const fallbackText = previousFailure ? `\n\n后台重试原因：${previousFailure}` : "";
    return { ok: false, content: `${agent.name} 已返回，但没有提取到文本内容。${debugText}${fallbackText}` };
  } catch (error) {
    return { ok: false, content: `本轮未完成：${error.message}` };
  }
}

function buildDebatePrompt({ topic, role, transcript }) {
  const previous = transcript.length
    ? transcript.map((item) => `${item.role}（${item.speaker}）：\n${item.content}`).join("\n\n")
    : "暂无前序发言。";
  const outputRules = getDebateOutputRules(activeDebateFlow);

  return [
    "你正在参与一场结构化辩论，请严格按照你的角色立场发言。",
    "",
    `辩题：${topic}`,
    "",
    `当前轮次：${role.title}`,
    `你的立场与任务：${role.instruction}`,
    "",
    "前序辩论记录：",
    previous,
    "",
    "输出要求：",
    ...outputRules.map((rule) => `- ${rule}`)
  ].join("\n");
}

function getDebateOutputRules(flow) {
  const rules = Array.isArray(flow?.outputRules) ? flow.outputRules.filter(Boolean) : [];
  return [
    "只输出纯文本，禁止生成文件、代码块、图表、附件或任何非文本内容。",
    "用 Markdown 列表或短段落组织结构，方便辩论室展示。",
    ...rules
  ];
}

function addSystemMessage(content) {
  state.messages.push(createMessage({
    speaker: "AgentDebate",
    speakerId: "moderator",
    mark: "M",
    round: "提示",
    content
  }));
}

function getAgentById(agentId) {
  return AGENTS.find((agent) => agent.id === agentId) || null;
}

function setRunning(isRunning) {
  state.isRunning = isRunning;

  composer.classList.toggle("hidden", isRunning);
  roleAssignments.closest(".roles").classList.toggle("hidden", isRunning);
  promptInput.disabled = isRunning;
  submitButton.disabled = isRunning;
  submitButton.textContent = isRunning ? "辩论中" : "开始辩论";

  if (!isRunning) {
    promptInput.value = state.promptDraft;
  }
}

async function persist() {
  await storage.set({
    agentdebate: {
      messages: state.messages,
      debateFlowId: state.debateFlowId,
      roleAssignmentsByFlow: state.roleAssignmentsByFlow,
      promptDraft: state.promptDraft,
      runId: state.runId,
      wasRunning: state.isRunning
    }
  });
}

function persistPromptDraftFromInput() {
  if (state.isRunning) return;
  state.promptDraft = promptInput.value;
  persist();
}

async function restore() {
  const saved = await storage.get("agentdebate");
  if (!saved.agentdebate) {
    renderFlowSelector();
    render();
    renderRoleAssignments();
    return;
  }

  applySavedState(saved.agentdebate);
}

function applySavedState(savedState) {
  state.messages = savedState.messages || [];
  state.promptDraft = savedState.promptDraft || "";
  state.runId = savedState.runId || 0;
  setActiveDebateFlow(savedState.debateFlowId || DEFAULT_DEBATE_FLOW_ID);
  state.roleAssignmentsByFlow = restoreRoleAssignmentsByFlow(savedState);
  state.isRunning = Boolean(savedState.wasRunning);

  promptInput.value = state.promptDraft;
  renderFlowSelector();
  renderRoleAssignments();
  render();
  setRunning(state.isRunning);
}

async function sendControlMessage(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({
    source: "agentdebate-control",
    type,
    payload
  });

  if (!response?.ok) {
    throw new Error(response?.error || "后台辩论室响应失败");
  }

  return response;
}

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const topic = promptInput.value.trim();
  if (!topic || state.isRunning) return;
  state.promptDraft = promptInput.value;
  const runId = state.runId + 1;
  state.runId = runId;
  setRunning(true);

  try {
    await sendControlMessage("START_DEBATE", {
      topic,
      debateFlowId: state.debateFlowId,
      roleAssignmentsByFlow: state.roleAssignmentsByFlow,
      promptDraft: state.promptDraft
    });
  } catch (error) {
    setRunning(false);
    addSystemMessage(`后台辩论室启动失败：${error.message || String(error)}`);
    render();
    await persist();
  }
});

promptInput.addEventListener("input", async () => {
  if (state.isRunning) return;
  state.promptDraft = promptInput.value;
  await persist();
});

if (debateFlowSelect) {
  debateFlowSelect.addEventListener("change", async () => {
    if (state.isRunning) return;
    setActiveDebateFlow(debateFlowSelect.value);
    renderRoleAssignments();
    render();
    await persist();
  });
}

clearButton.addEventListener("click", async () => {
  state.runId += 1;
  state.isRunning = false;
  state.messages = [];
  state.promptDraft = "";
  promptInput.value = "";
  setRunning(false);
  await persist();
  render();
  refreshProviderStatuses();
  try {
    await sendControlMessage("STOP_DEBATE");
  } catch (_error) {
    // Local reset already reflects the user's intent; the next run will create a fresh runner.
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    refreshProviderStatuses();
    return;
  }

  persistPromptDraftFromInput();
});

window.addEventListener("pagehide", () => {
  persistPromptDraftFromInput();
});

window.addEventListener("beforeunload", () => {
  persistPromptDraftFromInput();
});

window.addEventListener("focus", () => {
  refreshProviderStatuses();
});

window.addEventListener("blur", () => {
  persistPromptDraftFromInput();
});

window.addEventListener("message", handleAgentFrameMessage);

if (globalThis.chrome?.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes.agentdebate?.newValue) return;
    applySavedState(changes.agentdebate.newValue);
    refreshProviderStatuses();
  });
}

renderAgentList();
restore().then(refreshProviderStatuses);
