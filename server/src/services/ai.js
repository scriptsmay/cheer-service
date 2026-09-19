'use strict';

/**
 * AI 调用层 — OpenAI 兼容 API 封装
 *
 * 替代 TCB AI 网关 `app.ai().createModel('cloudbase').generateText()`
 * 所有参数通过环境变量配置，可灵活切换 DeepSeek / OpenAI / 本地 Ollama 等
 */

const { getEffectiveConfig } = require('./ai-config');
const config = require('../config/env');

/**
 * 调用 OpenAI 兼容的 /chat/completions 端点
 * @param {Object} opts
 * @param {Array}  opts.messages   - 对话消息数组
 * @param {number} opts.temperature - 温度 (默认 0.85)
 * @param {boolean} opts.jsonMode   - 是否强制 JSON 输出
 * @param {number} [opts.frequency_penalty] - 频率惩罚（v1.1.0 Task 6，可选，经 prompts 配置下发）
 * @param {number} [opts.presence_penalty]  - 存在惩罚（v1.1.0 Task 6，可选）
 * @returns {Promise<{text: string, usage: Object}>}
 */
async function generateText({ messages, temperature = 0.85, jsonMode = false, frequency_penalty, presence_penalty }) {
  const { baseUrl, apiKey, model } = getEffectiveConfig();

  const body = {
    model,
    messages,
    temperature,
  };

  // 采样惩罚参数仅在显式提供且为有限数字时下发（0 值也下发，保证后台调参可观测）
  if (Number.isFinite(frequency_penalty)) body.frequency_penalty = frequency_penalty;
  if (Number.isFinite(presence_penalty)) body.presence_penalty = presence_penalty;

  if (jsonMode) {
    body.response_format = { type: 'json_object' };
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.aiTimeoutMs || 180000),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`AI API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const msg = data.choices?.[0]?.message;
  return {
    // 部分模型（如 LongCat）在 json_object 模式下把输出放到 reasoning_content
    text: msg?.content || msg?.reasoning_content || '',
    usage: {
      total_tokens: data.usage?.total_tokens || 0,
      prompt_tokens: data.usage?.prompt_tokens || 0,
      completion_tokens: data.usage?.completion_tokens || 0,
    },
  };
}

module.exports = { generateText };
