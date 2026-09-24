'use strict';

/**
 * prompt-template.js — 提示词模板渲染单点（v1.1.0 提示词配置化）
 *
 * 职责（分层红线：本模块只做「渲染与校验」，不做档位计算与存储）：
 *  - 占位符白名单渲染：模板中仅白名单内 {{key}} 会被替换，其余原样保留
 *  - 插值清洗：换行折叠（防事件 title 手滑夹带指令文本破坏 prompt 结构）+ 长度截断（防 prompt 膨胀）
 *  - 残留校验：渲染后残留 {{…}} 视为模板错误，保存时拒绝、运行时回退默认模板
 *
 * 白名单（v1.1.0 计划 + 补充 {{event_min_lines}}，见 ADR-008 / 计划文档 Task 3）：
 *  {{line_count}} {{line_min_chars}} {{event_min_lines}} {{event_text}}
 *  {{date_label}} {{anchors_text}} {{recent_openings}} {{roles_hint}}
 */

// 各插值变量的最大长度（超长截断，防止后台配置或事件数据撑爆 prompt）
const INTERP_LIMITS = {
  line_count: 4,
  line_min_chars: 4,
  event_min_lines: 4,
  event_text: 80,
  date_label: 40,
  anchors_text: 500,
  recent_openings: 600,
  roles_hint: 300,
  user_text: 120, // 与路由入参 120 字上限一致
};

const PLACEHOLDER_RE = /\{\{\s*([a-z_]+)\s*\}\}/gu;
const RESIDUAL_RE = /\{\{[^}]{0,80}\}\}/gu;

/** 清洗插值值：去首尾空白、折叠换行与连续空白、按白名单上限截断 */
function sanitizeInterpolation(key, value) {
  const limit = INTERP_LIMITS[key] || 100;
  const text = String(value ?? '');
  return text.replace(/[\r\n\t]+/gu, ' ').replace(/\s{2,}/gu, ' ').trim().slice(0, limit);
}

/**
 * 渲染模板：仅替换白名单占位符；未提供值的白名单占位符同样原样保留（由残留校验兜底）。
 * @param {string} template 模板文本（含 {{key}} 占位符）
 * @param {Record<string, unknown>} vars 插值变量
 * @returns {{ ok: boolean, text: string, residual: string[] }} residual 为渲染后仍残留的占位符原文
 */
function renderTemplate(template, vars = {}) {
  if (typeof template !== 'string') return { ok: false, text: '', residual: ['<non-string template>'] };
  const text = template.replace(PLACEHOLDER_RE, (raw, key) => {
    if (!(key in INTERP_LIMITS) || !(key in vars)) return raw; // 非白名单 / 未提供 → 原样保留，交给残留校验
    return sanitizeInterpolation(key, vars[key]);
  });
  const residual = text.match(RESIDUAL_RE) || [];
  return { ok: residual.length === 0, text, residual };
}

/** 提取模板中的非白名单占位符（保存前快速反馈，无需构造插值样本） */
function findUnknownPlaceholders(template) {
  if (typeof template !== 'string') return ['<non-string template>'];
  const unknown = [];
  for (const match of template.matchAll(PLACEHOLDER_RE)) {
    if (!(match[1] in INTERP_LIMITS)) unknown.push(match[0]);
  }
  return unknown;
}

/** 供保存时残留校验使用的插值样本（覆盖全部白名单键） */
function sampleVars() {
  return {
    line_count: 5,
    line_min_chars: 20,
    event_min_lines: 1,
    event_text: '距离 9月28日 的亚运会王者荣耀金牌赛，还有 26 天',
    date_label: '9月2日 星期三',
    anchors_text: '26 天后，亚运赛场见',
    recent_openings: '今天也要加油呀、翻出旧录像又看了一遍',
    roles_hint: '日常陪伴 / 赛事轻提 / 回忆杀 / 互动提问 / 应援口号',
    user_text: '9月顺利，加油',
  };
}

/**
 * 保存前校验：模板必须可被无残留渲染。
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateTemplate(template) {
  const errors = [];
  if (typeof template !== 'string' || !template.trim()) {
    return { ok: false, errors: ['模板必须为非空字符串'] };
  }
  if (template.length > 2000) errors.push('模板长度超过 2000 字符上限');
  for (const raw of findUnknownPlaceholders(template)) {
    errors.push(`非法占位符 ${raw}（不在白名单内）`);
  }
  const rendered = renderTemplate(template, sampleVars());
  for (const token of rendered.residual) {
    errors.push(`渲染后残留占位符 ${token}（缺少对应插值变量）`);
  }
  return { ok: errors.length === 0, errors };
}

// ── 代码默认提示词模板（分层红线中的「代码默认」侧：可被后台配置覆盖，删配置即回此处）──
// version: 0 表示未自定义；每次后台保存自增，ai_reports 记录该值用于效果归因与回滚
const DEFAULT_PROMPTS = {
  version: 0,
  line_count: 5,
  line_min_chars: 20,
  line_target_range: '30-50',
  event_min_lines_preview: 1,
  event_min_lines_strong: 1,
  event_strong_hint: '今日赛事是本次文案的核心素材：{{line_count}} 条文案中至少 {{event_min_lines}} 条要自然体现这一赛事语境（倒计时、临场期待或当日应援均可），\n倒计时可以直接使用今日背景中给出的天数；其余文案保持日常陪伴感，不要每条都写赛事。',
  event_preview_hint: '今日背景中的赛事处于预热期：{{line_count}} 条文案中至少 {{event_min_lines}} 条要轻提赛事（一句带过即可，如"还有 N 天"），其余保持日常；\n倒数天数每条文案最多出现一次，不要 {{line_count}} 条全挂倒数，也不要把预热写成临场氛围。',
  date_context_hint: '可以自然地融入节气/节日氛围或今日赛事，但每条文案最多提及一次时间语境，不要为了塞日期破坏口语感，也不要写成天气预报或赛事播报。',
  // 用户补充提示（text 非空时替换原「用户补充：」行）：给模型明确指令把补充内容织入文案，
  // 否则补充行会被角色分工/格式约束淹没（线上疑问：text 无权重感，根因即此）
  user_text_hint: '用户补充是用户此刻想传达的话：「{{user_text}}」。至少一条文案要自然呼应或化用其内容，其余保持原有角色角度；不要逐字照抄整句，不要生硬嵌字。',
  // 采样惩罚参数（v1.1.0 Task 6）：**当前模型不支持，保留字段为将来切模型留退路**。
  // DeepSeek 系 API 已官方标注 frequency_penalty / presence_penalty 为 deprecated
  // （原文："It will not take effect if you pass it to the API"），服务端静默丢弃、不报错。
  // 且其原理是单次请求内的 token 惩罚，本就无法解决跨请求/跨天的文案雷同。
  // 防重复实际由 cheer.js 的「历史开头注入 + repeat_opening 校验层」承担；
  // 后台界面已移除这两个旋钮（v1.4.1），避免"已配置防重复"的错觉。
  // 若将来切回 OpenAI / 通义等支持该参数的模型，ai.js 的透传逻辑可直接复用。
  frequency_penalty: 0,
  presence_penalty: 0,
  // candidate_count > 1 时一次生成多候选校验择优（免费期零负担，出免费期建议回 1）
  candidate_count: 1,
  few_shot_examples: [],
};

module.exports = {
  INTERP_LIMITS,
  DEFAULT_PROMPTS,
  renderTemplate,
  findUnknownPlaceholders,
  validateTemplate,
  sampleVars,
};
