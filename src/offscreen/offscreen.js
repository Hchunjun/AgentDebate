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
const FRAME_MESSAGE_SOURCE = "agentdebate-frame-host";
const FRAME_RESPONSE_SOURCE = "agentdebate-frame";
const IFRAME_UNSTABLE_AGENTS = new Set(["gpt"]);

let activeDebateFlow = getDebateFlowById(DEFAULT_DEBATE_FLOW_ID);
let activeDebateRoles = activeDebateFlow.roles || [];
let frameMessageSeq = 0;
const pendingFrameMessages = new Map();
const lastAgentTargets = new Map();

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

const agentFrameHost = document.querySelector("#agentFrameHost");
let restoreReady = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.source !== "agentdebate-background") return false;

  handleControlMessage(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));

  return true;
});

window.addEventListener("message", handleAgentFrameMessage);

async function handleControlMessage(message) {
  if (restoreReady) await restoreReady;

  if (message.type === "START_DEBATE") {
    await startDebate(message.payload || {});
    return { ok: true };
  }

  if (message.type === "STOP_DEBATE") {
    await stopDebate();
    return { ok: true };
  }

  if (message.type === "GET_DEBATE_STATE") {
    await restore();
    return { ok: true, state: toPersistedState() };
  }

  return { ok: false, error: `未知控制消息：${message.type}` };
}

async function startDebate(payload) {
  const topic = String(payload.topic || "").trim();
  if (!topic) throw new Error("辩题不能为空");

  setActiveDebateFlow(payload.debateFlowId || DEFAULT_DEBATE_FLOW_ID);
  state.roleAssignmentsByFlow = restoreRoleAssignmentsByFlow({
    roleAssignmentsByFlow: payload.roleAssignmentsByFlow || state.roleAssignmentsByFlow
  });
  ensureRoleAssignmentsForFlow(activeDebateFlow);

  state.runId += 1;
  state.isRunning = true;
  state.promptDraft = payload.promptDraft || topic;
  state.messages = [];
  await persist();

  const runId = state.runId;
  runDebate(topic, runId)
    .catch(async (error) => {
      if (!isCurrentRun(runId)) return;
      addSystemMessage(`辩论已中止：${error.message || String(error)}`);
      await persist();
    })
    .finally(async () => {
      if (state.runId !== runId) return;
      state.isRunning = false;
      await persist();
    });
}

async function stopDebate() {
  state.runId += 1;
  state.isRunning = false;
  state.messages = [];
  state.promptDraft = "";
  await persist();
}

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

  return restored;
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

async function runDebate(topic, runId) {
  if (!isCurrentRun(runId)) return;

  state.messages.push(createMessage({
    speaker: "我",
    speakerId: "user",
    mark: "",
    round: "辩题",
    content: topic
  }));
  await persist();

  const transcript = [];

  for (const role of activeDebateRoles) {
    if (!isCurrentRun(runId)) return;

    const agent = getAgentById(getCurrentRoleAssignments()[role.id]);
    if (!agent) {
      addSystemMessage(`辩论已中止：${role.title} 未配置 Agent。`);
      await persist();
      return;
    }

    const prompt = buildDebatePrompt({ topic, role, transcript });

    state.messages.push(createMessage({
      speaker: agent.name,
      speakerId: agent.id,
      mark: agent.mark,
      round: role.title,
      roleTitle: role.title,
      content: ""
    }));
    await persist();

    const messageIndex = state.messages.length - 1;
    const result = await requestDebateTurn(agent, prompt, messageIndex, runId);
    if (!isCurrentRun(runId)) return;

    state.messages[messageIndex].content = result.content;
    state.messages[messageIndex].htmlContent = result.htmlContent || "";
    await persist();

    if (!result.ok) {
      addSystemMessage(`辩论已中止：${role.title} 没有完成，后续轮次未执行。`);
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
    if (!isCurrentRun(runId)) throw new Error("本轮已终止");

    const target = await ensureAgentTarget(agent);
    if (!isCurrentRun(runId)) throw new Error("本轮已终止");

    const result = await requestDebateTurnWithTarget(agent, prompt, messageIndex, target, runId);
    if (result.ok || target.mode !== "frame") return result;

    const tabTarget = await ensureAgentTab(agent);
    rememberAgentTarget(agent, tabTarget);
    if (!isCurrentRun(runId)) throw new Error("本轮已终止");

    return requestDebateTurnWithTarget(agent, prompt, messageIndex, tabTarget, runId, result.content);
  } catch (error) {
    return { ok: false, content: `本轮未完成：${error.message}` };
  }
}

async function requestDebateTurnWithTarget(agent, prompt, messageIndex, target, runId, previousFailure = "") {
  try {
    if (!isCurrentRun(runId)) throw new Error("本轮已终止");

    const previousAnswer = await getLatestAnswer(target);
    if (!isCurrentRun(runId)) throw new Error("本轮已终止");

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
      if (!isCurrentRun(runId)) throw new Error("本轮已终止");

      await delay(1200);
      if (!isCurrentRun(runId)) throw new Error("本轮已终止");

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
            await persist();
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

function getAgentFrame(agent) {
  return Array.from(agentFrameHost.querySelectorAll("iframe"))
    .find((frame) => frame.dataset.agent === agent.id) || null;
}

function createAgentFrame(agent) {
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

    pendingFrameMessages.set(requestId, { frame, resolve, reject, timeout });

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

async function ensureAgentFrame(agent) {
  const newChatUrl = NEW_CHAT_URLS[agent.id];
  if (!newChatUrl) throw new Error(`${agent.name} 无法自动打开`);

  const frame = getAgentFrame(agent) || createAgentFrame(agent);
  const loadPromise = waitForFrameLoad(frame);
  frame.src = newChatUrl;
  await loadPromise;
  await delay(2000);
  await waitForAgentFrameReady(frame, agent);

  return { mode: "frame", frame };
}

async function ensureAgentTab(agent) {
  const newChatUrl = NEW_CHAT_URLS[agent.id];
  let tab = await findProviderTab(agent);

  if (tab?.id) {
    if (newChatUrl) {
      tab = await backgroundRequest("TABS_UPDATE", { tabId: tab.id, updateProperties: { url: newChatUrl } });
      await backgroundRequest("TABS_WAIT_LOAD", { tabId: tab.id });
    }
  } else {
    if (!newChatUrl) throw new Error(`${agent.name} 无法自动打开`);

    tab = await backgroundRequest("TABS_CREATE", { createProperties: { url: newChatUrl, active: false } });
    await backgroundRequest("TABS_WAIT_LOAD", { tabId: tab.id });
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

  return backgroundRequest("TABS_SEND_MESSAGE", { tabId: target.id, message });
}

async function findProviderTab(agent) {
  const tabs = await backgroundRequest("TABS_QUERY", { queryInfo: {} });
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

async function getProviderStatusFromTab(tab) {
  try {
    return await backgroundRequest("TABS_SEND_MESSAGE", {
      tabId: tab.id,
      message: {
        source: "agentdebate",
        type: "GET_AGENTDEBATE_SITE_STATUS"
      }
    });
  } catch (error) {
    if (!shouldInjectAfterMessageError(error)) throw error;

    await backgroundRequest("SCRIPTING_EXECUTE", {
      tabId: tab.id,
      files: ["src/providerConfig.js", "src/content/agentAdapter.js"]
    });
    return backgroundRequest("TABS_SEND_MESSAGE", {
      tabId: tab.id,
      message: {
        source: "agentdebate",
        type: "GET_AGENTDEBATE_SITE_STATUS"
      }
    });
  }
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

function shouldInjectAfterMessageError(error) {
  return /Could not establish connection|Receiving end does not exist/i.test(error.message || "");
}

async function backgroundRequest(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({
    source: "agentdebate-offscreen",
    type,
    payload
  });

  if (!response?.ok) {
    throw new Error(response?.error || `${type} 执行失败`);
  }

  return response.result;
}

function isCurrentRun(runId) {
  return state.isRunning && state.runId === runId;
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

async function restore() {
  const saved = await backgroundRequest("STORAGE_GET", { key: "agentdebate" });
  if (!saved.agentdebate) return;

  state.messages = saved.agentdebate.messages || [];
  state.promptDraft = saved.agentdebate.promptDraft || "";
  state.runId = saved.agentdebate.runId || 0;
  state.isRunning = Boolean(saved.agentdebate.wasRunning);
  setActiveDebateFlow(saved.agentdebate.debateFlowId || DEFAULT_DEBATE_FLOW_ID);
  state.roleAssignmentsByFlow = restoreRoleAssignmentsByFlow(saved.agentdebate);
}

async function persist() {
  await backgroundRequest("STORAGE_SET", { values: { agentdebate: toPersistedState() } });
}

function toPersistedState() {
  return {
    messages: state.messages,
    debateFlowId: state.debateFlowId,
    roleAssignmentsByFlow: state.roleAssignmentsByFlow,
    promptDraft: state.promptDraft,
    runId: state.runId,
    wasRunning: state.isRunning
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

restoreReady = restore();
