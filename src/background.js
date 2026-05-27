const OFFSCREEN_URL = "src/offscreen/offscreen.html";

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  await chrome.sidePanel.open({ tabId: tab.id });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !["agentdebate-control", "agentdebate-offscreen"].includes(message.source)) return false;

  handleMessage(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));

  return true;
});

async function handleMessage(message) {
  if (message.source === "agentdebate-control") {
    return handleControlMessage(message);
  }

  if (message.source === "agentdebate-offscreen") {
    return handleOffscreenBridge(message);
  }

  return { ok: false, error: `未知消息来源：${message.source}` };
}

async function handleControlMessage(message) {
  if (message.type === "START_DEBATE") {
    await ensureOffscreenDocument();
    return sendOffscreenMessage({ type: "START_DEBATE", payload: message.payload || {} });
  }

  if (message.type === "STOP_DEBATE") {
    await ensureOffscreenDocument();
    return sendOffscreenMessage({ type: "STOP_DEBATE" });
  }

  if (message.type === "GET_DEBATE_STATE") {
    await ensureOffscreenDocument();
    return sendOffscreenMessage({ type: "GET_DEBATE_STATE" });
  }

  return { ok: false, error: `未知控制消息：${message.type}` };
}

async function sendOffscreenMessage(message) {
  const response = await chrome.runtime.sendMessage({
    source: "agentdebate-background",
    ...message
  });

  if (!response?.ok) {
    throw new Error(response?.error || "后台辩论室响应失败");
  }

  return response;
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen?.createDocument) {
    throw new Error("当前浏览器不支持 offscreen 后台页面，关闭侧边栏后无法继续辩论");
  }

  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_URL);
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl]
    });
    if (contexts.length) return;
  }

  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["IFRAME_SCRIPTING"],
      justification: "Run AI debate iframes while the side panel is closed."
    });
  } catch (error) {
    if (!/Only a single offscreen document may be created/i.test(error.message || "")) {
      throw error;
    }
  }
}

async function handleOffscreenBridge(message) {
  const payload = message.payload || {};

  if (message.type === "TABS_QUERY") {
    return { ok: true, result: await chrome.tabs.query(payload.queryInfo || {}) };
  }

  if (message.type === "TABS_CREATE") {
    return { ok: true, result: await chrome.tabs.create(payload.createProperties || {}) };
  }

  if (message.type === "TABS_UPDATE") {
    return { ok: true, result: await chrome.tabs.update(payload.tabId, payload.updateProperties || {}) };
  }

  if (message.type === "TABS_GET") {
    return { ok: true, result: await chrome.tabs.get(payload.tabId) };
  }

  if (message.type === "TABS_WAIT_LOAD") {
    await waitForTabLoad(payload.tabId, payload.timeoutMs);
    return { ok: true, result: true };
  }

  if (message.type === "TABS_SEND_MESSAGE") {
    return { ok: true, result: await sendTabMessage(payload.tabId, payload.message) };
  }

  if (message.type === "SCRIPTING_EXECUTE") {
    await chrome.scripting.executeScript({
      target: { tabId: payload.tabId },
      files: payload.files || []
    });
    return { ok: true, result: true };
  }

  if (message.type === "STORAGE_GET") {
    return { ok: true, result: await chrome.storage.local.get(payload.key) };
  }

  if (message.type === "STORAGE_SET") {
    await chrome.storage.local.set(payload.values || {});
    return { ok: true, result: true };
  }

  return { ok: false, error: `未知 offscreen 请求：${message.type}` };
}

function waitForTabLoad(tabId, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("页面加载超时"));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
    }

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        cleanup();
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) return;
      if (tab?.status === "complete") {
        cleanup();
        resolve();
      }
    });
  });
}

function sendTabMessage(tabId, message) {
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
