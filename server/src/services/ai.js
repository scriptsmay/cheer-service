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

/**
 * 流式调用 OpenAI 兼容的 /chat/completions 端点
 * @param {Object} opts
 * @param {Array}  opts.messages   - 对话消息数组
 * @param {number} opts.temperature - 温度 (默认 0.85)
 * @param {boolean} opts.jsonMode   - 是否强制 JSON 输出
 * @param {number} [opts.frequency_penalty] - 频率惩罚
 * @param {number} [opts.presence_penalty] - 存在惩罚
 * @param {Function} [opts.onChunk] - 收到 chunk 时的回调 (chunk: {type: 'reasoning'|'content'|'complete', data: string, fullText?: string}) => void
 * @returns {Promise<{text: string, usage: Object, reasoning: string}>}
 */
async function generateTextStream({ messages, temperature = 0.85, jsonMode = false, frequency_penalty, presence_penalty, onChunk }) {
  const { baseUrl, apiKey, model } = getEffectiveConfig();

  const body = {
    model,
    messages,
    temperature,
    stream: true,
  };

  if (Number.isFinite(frequency_penalty)) body.frequency_penalty = frequency_penalty;
  if (Number.isFinite(presence_penalty)) body.presence_penalty = presence_penalty;

  if (jsonMode) {
    body.response_format = { type: 'json_object' };
  }

  // 空闲超时（非总时长）：每次收到数据就重置计时器，
  // 思考型模型推理耗时不受 3 分钟墙钟限制，只要数据还在流动就不中断
  const idleTimeoutMs = config.aiStreamIdleTimeoutMs || 90000;
  const controller = new AbortController();
  let idleTimer = null;
  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      controller.abort(new Error(`AI 流式响应空闲超时：${Math.round(idleTimeoutMs / 1000)}s 未收到数据`));
    }, idleTimeoutMs);
  };
  armIdleTimer();

  let response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`AI API error ${response.status}: ${err}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let fullText = '';
    let reasoningText = '';
    let usage = null;
    let modelMeta = null;

    // SSE 解析辅助函数
    function parseSSELine(line) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') return { done: true };
        try {
          return { parsed: JSON.parse(data) };
        } catch {
          return null;
        }
      }
      if (line.startsWith(':keepalive')) {
        return { keepalive: true };
      }
      return null;
    }

    // 读取流
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdleTimer(); // 收到数据，重置空闲计时

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // 保留不完整的行

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const event = parseSSELine(trimmed);
        if (!event) continue;
        if (event.done) break;
        if (event.keepalive) {
          if (onChunk) onChunk({ type: 'keepalive' });
          continue;
        }
        if (event.parsed) {
          const chunk = event.parsed;
          modelMeta = modelMeta || { model: chunk.model, created: chunk.created };
          usage = usage || chunk.usage;

          const choice = chunk.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta || {};
          const reasoningContent = delta.reasoning_content;
          const content = delta.content;

          if (reasoningContent) {
            reasoningText += reasoningContent;
            if (onChunk) onChunk({ type: 'reasoning', data: reasoningContent, fullText: reasoningText });
          }

          if (content) {
            fullText += content;
            if (onChunk) onChunk({ type: 'content', data: content, fullText });
          }

          if (choice.finish_reason === 'stop') {
            usage = chunk.usage;
          }
        }
      }
    }

    return {
      text: fullText,
      reasoning: reasoningText,
      usage: usage || { total_tokens: 0, prompt_tokens: 0, completion_tokens: 0 },
    };
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }
}

module.exports = { generateText, generateTextStream };
