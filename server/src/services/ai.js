'use strict';

/**
 * AI 调用层 — OpenAI 兼容 API 封装
 *
 * 替代 TCB AI 网关 `app.ai().createModel('cloudbase').generateText()`
 * 所有参数通过环境变量配置，可灵活切换 DeepSeek / OpenAI / 本地 Ollama 等
 */

const { getEffectiveConfig } = require('./ai-config');
const config = require('../config/env');

class AIStreamTimeoutError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AIStreamTimeoutError';
    this.code = code;
    Object.assign(this, details);
  }
}

const STREAM_USAGE_FIELDS = ['total_tokens', 'prompt_tokens', 'completion_tokens'];

function mergeStreamUsage(target, incoming) {
  if (!incoming || typeof incoming !== 'object') return target;
  for (const field of STREAM_USAGE_FIELDS) {
    const value = Number(incoming[field]);
    if (!Number.isFinite(value) || value < 0) continue;
    target[field] = Math.max(target[field] || 0, value);
  }
  return Object.keys(target).length ? target : null;
}

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
  const { baseUrl, apiKey, model, thinkingBudget } = await getEffectiveConfig();

  const body = {
    model,
    messages,
    temperature,
  };

  // 思考预算（Qwen3 系经 LiteLLM 实测透传有效）：控制推理长度，降低耗时与 token 消耗
  if (Number.isFinite(thinkingBudget)) body.thinking_budget = thinkingBudget;

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
 * @returns {Promise<{text: string, usage: Object, reasoning: string, model: string|null}>}
 */
async function generateTextStream({ messages, temperature = 0.85, jsonMode = false, frequency_penalty, presence_penalty, onChunk, deadlineAt }) {
  const idleTimeoutMs = config.aiStreamIdleTimeoutMs || 90000;
  const totalTimeoutMs = config.aiStreamTotalTimeoutMs || 240000;
  const effectiveDeadlineAt = Number.isFinite(deadlineAt) ? deadlineAt : Date.now() + totalTimeoutMs;
  const controller = new AbortController();
  let timeoutTimer = null;
  let lastUpstreamActivityAt = Date.now();
  let model = null;
  let actualModel = null;
  let usage = null;
  const abortWithTimeout = (code, message) => {
    const details = {
      model: actualModel || model,
      lastUpstreamActivityMs: Date.now() - lastUpstreamActivityAt,
    };
    if (usage) details.usage = { ...usage };
    const error = new AIStreamTimeoutError(code, message, details);
    controller.abort(error);
  };
  const armTimeout = () => {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    const now = Date.now();
    const idleDeadlineAt = lastUpstreamActivityAt + idleTimeoutMs;
    const totalWins = effectiveDeadlineAt <= idleDeadlineAt;
    const nextDeadlineAt = totalWins ? effectiveDeadlineAt : idleDeadlineAt;
    const code = totalWins ? 'AI_STREAM_TOTAL_TIMEOUT' : 'AI_STREAM_IDLE_TIMEOUT';
    const message = totalWins
      ? `AI 流式响应总超时：${Math.round(totalTimeoutMs / 1000)}s 未完成`
      : `AI 流式响应空闲超时：${Math.round(idleTimeoutMs / 1000)}s 未收到数据`;
    timeoutTimer = setTimeout(() => abortWithTimeout(code, message), Math.max(0, nextDeadlineAt - now));
  };
  armTimeout();

  let response;
  try {
    const abortPromise = new Promise((_, reject) => {
      if (controller.signal.aborted) {
        reject(controller.signal.reason);
        return;
      }
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    });
    const { baseUrl, apiKey, model: configuredModel, thinkingBudget } = await Promise.race([
      getEffectiveConfig(),
      abortPromise,
    ]);
    model = configuredModel;

    const body = {
      model,
      messages,
      temperature,
      stream: true,
    };

    if (Number.isFinite(thinkingBudget)) body.thinking_budget = thinkingBudget;

    if (Number.isFinite(frequency_penalty)) body.frequency_penalty = frequency_penalty;
    if (Number.isFinite(presence_penalty)) body.presence_penalty = presence_penalty;

    if (jsonMode) {
      body.response_format = { type: 'json_object' };
    }

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
      lastUpstreamActivityAt = Date.now();
      armTimeout();

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
          if (typeof chunk.model === 'string' && chunk.model) actualModel = chunk.model;
          usage = mergeStreamUsage(usage || {}, chunk.usage);

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
            usage = mergeStreamUsage(usage || {}, chunk.usage);
          }
        }
      }
    }

    return {
      text: fullText,
      reasoning: reasoningText,
      model: actualModel || model,
      usage: usage || { total_tokens: 0, prompt_tokens: 0, completion_tokens: 0 },
    };
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason || error;
    throw error;
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
  }
}

module.exports = { generateText, generateTextStream, AIStreamTimeoutError };
