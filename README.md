# AgentDebate

AgentDebate 是一个 Chrome MV3 浏览器插件原型，定位是”浏览器 AI 辩论室”。

用户只输入辩题，AgentDebate 负责编排已登录的 AI 网页按角色发言。角色不绑定固定 Agent，用户可以在侧边栏中选择裁判、正方、反方分别由 GPT、Kimi、DeepSeek、豆包或千问承担；辩论流程与角色提示词在 `src/debateFlowConfig.js` 中配置。

当前版本重点是辩论流程编排和网页适配器原型。

## 产品定义

- 人类：只提供辩题
- 角色分配：用户选择裁判、正方、反方分别由哪个 Agent 承担
- 辩论编排：AgentDebate 按 `src/debateFlowConfig.js` 中选中的流程顺序向对应 Agent 发送带上下文的轮次 prompt；当配置中存在多个流程时，侧边栏会显示流程选择器
- 裁判总结：由用户选择的真实 Agent 完成，不由 AgentDebate 本地假装智能裁决
- 适配器：为 ChatGPT、Kimi、DeepSeek、豆包分别实现网页输入和回答提取

## 目录

```text
AgentDebate/
  manifest.json
  src/
    background.js
    debateFlowConfig.js
    providerConfig.js
    content/
      agentAdapter.js
    sidepanel/
      sidepanel.html
      sidepanel.css
      sidepanel.js
```

## 本地加载

1. 打开 Chrome 的 `chrome://extensions`
2. 开启“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择 AgentDebate 项目根目录
5. 打开需要使用的 AI 网页并保持登录
6. 点击浏览器工具栏里的 AgentDebate 图标，打开侧边栏

## 下一步

1. 校准豆包真实 DOM 选择器
2. 增加辩论中止、单轮重试、超时状态展示
3. 支持自定义辩论轮次和角色模板
4. 增加 transcript 导出
