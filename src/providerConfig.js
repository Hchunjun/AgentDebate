(function initAgentDebateProviderConfig(globalScope) {
  const agents = [
    { id: "gpt", name: "GPT", mark: "G" },
    { id: "kimi", name: "Kimi", mark: "K" },
    { id: "deepseek", name: "DeepSeek", mark: "D" },
    { id: "doubao", name: "豆包", aliases: ["Doubao"], mark: "豆" }
  ];

  const providers = [
    {
      id: "gpt",
      name: "GPT",
      host: "chatgpt.com",
      newChatUrl: "https://chatgpt.com/",
      stableMs: 5000,
      searchHandler: {
        steps: [
          { action: "focus", selector: "#prompt-textarea", waitForElement: true },
          { action: "setValue", selector: "#prompt-textarea", inputType: "contenteditable", waitForElement: true },
          { action: "triggerEvents", selector: "#prompt-textarea", events: ["input", "change", "blur", "focus"] },
          { action: "wait", duration: 400 },
          {
            action: "click",
            selector: "button[data-testid=\"send-button\"], button[data-testid=\"composer-submit-button\"], button[aria-label*=\"发送\"], button[aria-label*=\"Send\"], button[class*=\"send\" i], button[type=\"submit\"]",
            retryOnDisabled: true,
            maxAttempts: 20,
            retryInterval: 200,
            optional: true
          },
          { action: "sendKeys", selector: "#prompt-textarea", keys: "Enter", optional: true }
        ]
      },
      contentExtractor: {
        messageContainer: "[data-message-author-role=\"assistant\"]",
        contentSelectors: [".markdown.prose", ".markdown", "[class*=\"markdown\"]", "div.whitespace-pre-wrap"]
      }
    },
    {
      id: "kimi",
      name: "Kimi",
      host: ["kimi.com", "www.kimi.com"],
      newChatUrl: "https://kimi.com/",
      stableMs: 5000,
      searchHandler: {
        steps: [
          {
            action: "focus",
            selector: "div.chat-input-editor[contenteditable=\"true\"], [data-lexical-editor=\"true\"][contenteditable=\"true\"]",
            waitForElement: true
          },
          {
            action: "setValue",
            selector: "div.chat-input-editor[contenteditable=\"true\"], [data-lexical-editor=\"true\"][contenteditable=\"true\"]",
            inputType: "contenteditable",
            waitForElement: true
          },
          { action: "wait", duration: 100 },
          {
            action: "sendKeys",
            selector: "div.chat-input-editor[contenteditable=\"true\"], [data-lexical-editor=\"true\"][contenteditable=\"true\"]",
            keys: "Enter",
            dispatchKeypress: false,
            waitForElement: true
          }
        ]
      },
      contentExtractor: {
        messageContainer: "div.segment.segment-assistant",
        contentSelectors: ["div.segment-content-box .markdown", "div.segment-content-box", "div.markdown", "p", "pre", "ul", "ol"]
      }
    },
    {
      id: "deepseek",
      name: "DeepSeek",
      host: "chat.deepseek.com",
      newChatUrl: "https://chat.deepseek.com/",
      stableMs: 5000,
      searchHandler: {
        steps: [
          { action: "focus", selector: "textarea[placeholder*=\"Message DeepSeek\"], textarea[placeholder*=\"DeepSeek\"], textarea[placeholder*=\"消息\"], textarea", waitForElement: true },
          { action: "setValue", selector: "textarea[placeholder*=\"Message DeepSeek\"], textarea[placeholder*=\"DeepSeek\"], textarea[placeholder*=\"消息\"], textarea", waitForElement: true },
          { action: "triggerEvents", selector: "textarea[placeholder*=\"Message DeepSeek\"], textarea[placeholder*=\"DeepSeek\"], textarea[placeholder*=\"消息\"], textarea", events: ["input", "change", "blur", "focus"] },
          { action: "wait", duration: 100 },
          { action: "sendKeys", selector: "textarea[placeholder*=\"Message DeepSeek\"], textarea[placeholder*=\"DeepSeek\"], textarea[placeholder*=\"消息\"], textarea", keys: "Enter", waitForElement: true }
        ]
      },
      // The current DeepSeek UI renders the finalized assistant answer in
      // `div.ds-markdown.ds-markdown--block`. The "thinking chain" lives in
      // a separate `.e1675d8b`-hash class and is intentionally NOT matched
      // here so we only collect the actual answer.
      contentExtractor: {
        messageContainer: "div.ds-markdown.ds-markdown--block, div.ds-markdown",
        contentSelectors: [],
        selectors: [
          "div.ds-markdown.ds-markdown--block",
          "div.ds-markdown",
          "[class*=\"ds-markdown\"]",
          ".deepseek-message .markdown",
          ".message-content .markdown",
          "[class*=\"response\"]",
          "[class*=\"chat-message\"]"
        ],
        fallbackSelectors: ["article", "[class*=\"content\"]"]
      }
    },
    {
      id: "doubao",
      name: "豆包",
      host: ["doubao.com", "www.doubao.com"],
      newChatUrl: "https://doubao.com/chat",
      stableMs: 5000,
      searchHandler: {
        // Selector order matters: precise selectors first (chat textarea /
        // data-testid containers), then the legacy bare `[contenteditable]`
        // as a last-resort so we never silently fail to find ANY input.
        steps: [
          {
            action: "focus",
            selector: "textarea[placeholder=\"发消息...\"], textarea[data-testid=\"chat_input_input\"], textarea.semi-input-textarea, [data-testid=\"chat_input_input\"] textarea, [role=\"textbox\"], textarea[placeholder=\"输入主题和报告要求\"], .message-input-textarea-separation, textarea[placeholder*=\"发消息\"], textarea[placeholder*=\"问豆包\"], textarea[placeholder*=\"输入\"], [data-testid*=\"chat-input\"] [contenteditable=\"true\"], [data-testid*=\"chat_input\"] [contenteditable=\"true\"], [contenteditable=\"true\"]",
            waitForElement: true
          },
          {
            action: "setValue",
            selector: "textarea[placeholder=\"发消息...\"], textarea[data-testid=\"chat_input_input\"], textarea.semi-input-textarea, [data-testid=\"chat_input_input\"] textarea, [role=\"textbox\"], textarea[placeholder=\"输入主题和报告要求\"], .message-input-textarea-separation, textarea[placeholder*=\"发消息\"], textarea[placeholder*=\"问豆包\"], textarea[placeholder*=\"输入\"], [data-testid*=\"chat-input\"] [contenteditable=\"true\"], [data-testid*=\"chat_input\"] [contenteditable=\"true\"], [contenteditable=\"true\"]",
            inputType: "contenteditable",
            waitForElement: true
          },
          {
            action: "triggerEvents",
            selector: "textarea[placeholder=\"发消息...\"], textarea[data-testid=\"chat_input_input\"], textarea.semi-input-textarea, [data-testid=\"chat_input_input\"] textarea, [role=\"textbox\"], textarea[placeholder=\"输入主题和报告要求\"], .message-input-textarea-separation, textarea[placeholder*=\"发消息\"], textarea[placeholder*=\"问豆包\"], textarea[placeholder*=\"输入\"], [data-testid*=\"chat-input\"] [contenteditable=\"true\"], [data-testid*=\"chat_input\"] [contenteditable=\"true\"], [contenteditable=\"true\"]",
            events: ["input", "change", "blur", "focus"]
          },
          { action: "wait", duration: 600 },
          {
            action: "click",
            selector: ".message-input-right-button-send button, .message-input-right-button-send [role=\"button\"], .message-input-right-button-send .omni-button-content-btn, #flow-end-msg-send, button[data-testid=\"chat_input_send_button\"], [data-testid=\"chat_input_send_button\"], button[aria-label*=\"发送\"], [role=\"button\"][aria-label*=\"发送\"], button[aria-label*=\"Send\"], [role=\"button\"][aria-label*=\"Send\"], button[aria-label*=\"Submit\"], button[title*=\"发送\"], button[class*=\"send\" i], [role=\"button\"][class*=\"send\" i]",
            retryOnDisabled: true,
            waitForElement: true,
            maxAttempts: 20,
            retryInterval: 200,
            optional: true
          },
          {
            action: "sendKeys",
            selector: "textarea[placeholder=\"发消息...\"], textarea[data-testid=\"chat_input_input\"], textarea.semi-input-textarea, [data-testid=\"chat_input_input\"] textarea, [role=\"textbox\"], textarea[placeholder=\"输入主题和报告要求\"], .message-input-textarea-separation, textarea[placeholder*=\"发消息\"], textarea[placeholder*=\"问豆包\"], textarea[placeholder*=\"输入\"], [data-testid*=\"chat-input\"] [contenteditable=\"true\"], [data-testid*=\"chat_input\"] [contenteditable=\"true\"], [contenteditable=\"true\"]",
            keys: "Enter",
            optional: true
          }
        ]
      },
      // Strict extraction: must locate an assistant message bubble. We
      // deliberately do NOT fall back to broad selectors like `main` or
      // `[role="log"]` because homepage chrome would otherwise be returned.
      contentExtractor: {
        latestVisibleResponse: {
          messageSelector: ".inner-item-w21SQO [class*=\"flow-markdown-body\"], .inner-item-w21SQO [class*=\"markdown-body\"]",
          ignoredAncestorSelectors: [
            "[class*=\"suggest-message\"]",
            "[class*=\"copy\"]",
            "[class*=\"regenerate\"]",
            "[class*=\"stop\"]"
          ]
        },
        messageContainer: ".inner-item-w21SQO, [data-testid=\"receive_message\"], [data-testid=\"message_block_receive\"], [data-testid=\"union_message\"] [data-testid=\"receive_message\"], [class*=\"bg-g-receive-msg-bubble\"], div[class*=\"receive-message\"], div[class*=\"ReceiveMessage\"], div[class*=\"receiveMessage\"]",
        contentSelectors: ["[class*=\"flow-markdown-body\"]", "[class*=\"markdown-body\"]", "[class*=\"md-box-root\"]", "[data-testid=\"message_text_content\"]", "[class*=\"markdown\"]", "[class*=\"rich-text\"]", "[class*=\"message-content\"]", "p"],
        selectors: [
          ".inner-item-w21SQO [class*=\"flow-markdown-body\"]",
          ".inner-item-w21SQO [class*=\"markdown-body\"]",
          "[class*=\"md-box-root\"]",
          "[data-testid=\"receive_message\"] [data-testid=\"message_text_content\"]"
        ],
        fallbackSelectors: [
          ".content-Xv_Zw0",
          ".message-list-S2Fv2S",
          ".scroll-view-OEiNXD.container-gkoWqI"
        ],
        excludeSelectors: [
          "[data-plugin-identifier=\"block_type:10000\"]",
          "nav",
          "header",
          "footer",
          ".sidebar",
          ".menu",
          "button",
          "textarea",
          ".copy-button",
          "[class*=\"copy\"]",
          ".regenerate-button",
          "[class*=\"regenerate\"]",
          ".stop-button",
          "[class*=\"stop\"]",
          "[data-testid*=\"input\"]",
          "[data-testid*=\"send\"]"
        ]
      }
    },
  ];

  globalScope.AgentDebateConfig = {
    agents,
    providers
  };
})(globalThis);
