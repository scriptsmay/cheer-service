'use strict';

/**
 * AI 调用层 — OpenAI 兼容 API 封装
 *
 * 替代 TCB AI 网关 `app.ai().createModel('cloudbase').generateText()`
 * 所有参数通过环境变量配置，可灵活切换 DeepSeek / OpenAI / 本地 Ollama 等
 */

const config = require('../config/env');

/**
 * 调用 OpenAI 兼容的 /chat/completions 端点
 * @param {Object} opts
 * @param {Array}  opts.messages   - 对话消息数组
 * @param {number} opts.temperature - 温度 (默认 0.85)
 * @param {boolean} opts.jsonMode   - 是否强制 JSON 输出
 * @returns {Promise<{text: string, usage: Object}>}
 */
async function generateText({ messages, temperature = 0.85, jsonMode = false }) {
  const body = {
    model: config.aiModel,
    messages,
    temperature,
  };

  if (jsonMode) {
    body.response_format = { type: 'json_object' };
  }

  const response = await fetch(`${config.aiBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.aiApiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`AI API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  return {
    text: data.choices?.[0]?.message?.content || '',
    usage: {
      total_tokens: data.usage?.total_tokens || 0,
      prompt_tokens: data.usage?.prompt_tokens || 0,
      completion_tokens: data.usage?.completion_tokens || 0,
    },
  };
}

module.exports = { generateText };
