(function initAgentDebateFlowConfig(globalScope) {
  const conciseRules = [
    "120-180 字，最多 3 条要点。",
    "第一句直接给结论，不做背景铺垫。",
    "每条要点只保留：主张、关键依据、推论。",
    "只回应本轮任务，不替其他角色发言。"
  ];

  const debateFlows = [
    {
      id: "fast-affirmative-negative-judge",
      name: "快速裁决",
      outputRules: conciseRules,
      roles: [
        {
          id: "affirmative",
          title: "正方",
          defaultAgentId: "gpt",
          instruction: "支持辩题成立。给出 2 个最强理由，并说明一个可验证的关键依据。"
        },
        {
          id: "negative",
          title: "反方",
          defaultAgentId: "deepseek",
          instruction: "反驳正方最关键的假设。指出 2 个逻辑漏洞、现实风险或反例。"
        },
        {
          id: "judge",
          title: "裁判",
          defaultAgentId: "doubao",
          instruction: "只基于双方发言裁决。说明哪一方更有说服力、核心理由是什么、还缺哪项验证。"
        }
      ]
    },
    {
      id: "criteria-first",
      name: "先定标准",
      outputRules: conciseRules,
      roles: [
        {
          id: "judge",
          title: "主持人",
          defaultAgentId: "doubao",
          instruction: "先定义评判标准。列出 3 个判断本辩题时最重要的维度，并提醒一个容易偷换的概念。不要裁决胜负。"
        },
        {
          id: "affirmative",
          title: "正方",
          defaultAgentId: "gpt",
          instruction: "按主持人的评判标准支持辩题。只选择最重要的 2 个维度展开论证。"
        },
        {
          id: "negative",
          title: "反方",
          defaultAgentId: "deepseek",
          instruction: "按主持人的评判标准反驳正方。优先攻击证据不足、边界条件和落地风险。"
        }
      ]
    },
    {
      id: "decision-review",
      name: "决策评审",
      outputRules: [
        "100-160 字，最多 3 条要点。",
        "使用 Markdown 列表，句子要短。",
        "必须给出可执行或可验证的信息。",
        "不要泛泛而谈，不要重复前序内容。"
      ],
      roles: [
        {
          id: "affirmative",
          title: "方案方",
          defaultAgentId: "gpt",
          instruction: "把辩题当作一个待评审方案。说明为什么值得做、最小可行做法是什么、预期收益是什么。"
        },
        {
          id: "negative",
          title: "风险方",
          defaultAgentId: "deepseek",
          instruction: "从失败成本、依赖条件和反例角度审查方案。指出最可能导致失败的 2 个风险。"
        },
        {
          id: "judge",
          title: "决策官",
          defaultAgentId: "doubao",
          instruction: "给出决策建议：推进、暂缓或否决。必须附带一个下一步验证动作。"
        }
      ]
    }
  ];

  globalScope.AgentDebateFlowConfig = {
    debateFlows,
    defaultDebateFlowId: "fast-affirmative-negative-judge"
  };
})(globalThis);
