# AI 生成统计参考面板与校验通过率优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 持久化每次 AI 生成尝试的模型与终态统计，在 admin 面板只读展示模型表现参考，同时降低过严校验造成的失败率。

**Architecture:** 新增轻量 `ai_generation_attempts` 记录，只保存请求终态、模型、耗时、重试、校验原因和 usage，不保存用户输入或密钥。流式与非流式生成统一写入该记录；admin 新增按时间窗口聚合的只读接口。校验优化限定为放宽重复开头判定和补齐日期/事件数字白名单，不放松 JSON、条数、长度和内容安全底线。

**Tech Stack:** Node.js/Express、Mongo/Postgres DB facade、原生 admin HTML/JavaScript、Node test runner。

**Spec:** `docs/superpowers/specs/2026-09-24-ai-generation-stats-validation-design.md`

## Global Constraints

- 不自动切换或覆盖 AI 模型；最终模型始终由用户手动保存。
- 统计只读，不暴露 API key、Authorization、完整 base URL、用户原文或完整思考内容。
- 日志/统计只记录脱敏 reason，不记录完整模型输出。
- 代码不新增注释；保持现有命名和 CommonJS 风格。
- 校验必须保留：JSON 解析、配置条数、每条硬下限 10 字、允许数字白名单、内容安全。
- 失败记录也必须可统计，不能只统计 `ai_reports` 成功记录。
- 完成后运行后端全量测试、相关 admin/流式测试及仓库 lint；仓库无构建流程。

---

### Task 1: 定义生成尝试记录与 schema

**Files:**
- Modify: `server/src/routes/cheer.js`
- Modify: `scripts/pg-create-schema.js`
- Modify: `scripts/create-indexes.js`
- Test: `server/tests/cheer-stream-route.test.js`

**Interfaces:**
- Produces a report field shape used by later aggregation: `request_id`, `model`, `status` (`complete`/`error`/`timeout`), `termination`, `elapsed_ms`, `retry_count`, `validation_failure`, `usage`, `created_at`.

- [ ] **Step 1: Add failing tests for attempt metadata**
  - Assert a successful stream route persists `model`, `status: complete`, `retry_count`, `validation_failure`, and `usage` in the generation-attempt store.
  - Assert a terminal output-invalid request persists `status: error`, `termination: output_invalid`, and the final validation reason.

- [ ] **Step 2: Run the focused tests and verify failure**
  Run: `node --test server/tests/cheer-stream-route.test.js`
  Expected: new tests fail because no attempt record is written.

- [ ] **Step 3: Implement a single attempt finalizer**
  - Add a helper in `server/src/routes/cheer.js` that writes a sanitized attempt document to the `ai_generation_attempts` collection.
  - Include request metadata already available in the observer and never include request body, output, reasoning, Authorization, API keys, or base URL.
  - Call it once for success, validation exhaustion, generation error, and deadline/idle termination paths; guard with a per-request finalization flag.

- [ ] **Step 4: Add schema and indexes**
  - Add the collection/table shape to `scripts/pg-create-schema.js` if the DB facade exposes explicit PostgreSQL schema definitions.
  - Add indexes for `created_at`, `model`, and `(created_at, model)` in `scripts/create-indexes.js`; follow existing index naming conventions.

- [ ] **Step 5: Run focused and full backend tests**
  Run: `node --test server/tests/cheer-stream-route.test.js` and `node --test server/tests/*.test.js`
  Expected: all tests pass.

- [ ] **Step 6: Commit**
  ```bash
  git add server/src/routes/cheer.js scripts/pg-create-schema.js scripts/create-indexes.js server/tests/cheer-stream-route.test.js
  git commit -m "feat(ai): persist generation attempt statistics"
  ```

---

### Task 2: Add read-only admin statistics API

**Files:**
- Modify: `server/src/routes/admin.js`
- Test: `server/tests/admin-ai-stats.test.js` (create if no existing admin test file)

**Interfaces:**
- `GET /api/admin/ai/stats?window=24h|7d|30d` requires admin auth and returns:
  `{ window, generated_at, models: [{ model, samples, complete, success_rate, p50_ms, p95_ms, retries, validation_failures, tokens }] }`.
- Invalid windows return the repository’s standard `INVALID_ARGUMENT` response.
- The endpoint is read-only and must not call `saveConfig` or mutate model configuration.

- [ ] **Step 1: Add failing aggregation tests**
  - Cover window filtering, model grouping, percentile calculation, failure reason counts, and an empty dataset.
  - Assert the endpoint requires `requireAuth` and does not expose secrets.

- [ ] **Step 2: Run the tests and verify failure**
  Run: `node --test server/tests/admin-ai-stats.test.js`
  Expected: route does not exist.

- [ ] **Step 3: Implement the endpoint**
  - Reuse the existing admin auth and response helpers.
  - Query only `ai_generation_attempts` metadata in the selected time window.
  - Compute success rate from terminal `complete` records, P50/P95 from `elapsed_ms`, and validation failure counts from `validation_failure`.
  - Return no raw request IDs, output text, user input, credentials, or full upstream configuration.

- [ ] **Step 4: Run focused and full tests**
  Run: `node --test server/tests/admin-ai-stats.test.js` and `node --test server/tests/*.test.js`
  Expected: all tests pass.

- [ ] **Step 5: Commit**
  ```bash
  git add server/src/routes/admin.js server/tests/admin-ai-stats.test.js
  git commit -m "feat(admin): expose AI generation performance stats"
  ```

---

### Task 3: Optimize validation without weakening hard rules

**Files:**
- Modify: `server/src/routes/cheer.js`
- Test: `server/tests/cheer-stream-route.test.js`
- Test: `server/tests/cheer-data-mode.test.js`

**Interfaces:**
- `inspectGeneratedOutput()` continues returning `{ ok: true, output }` or `{ ok: false, kind, reason, ... }`.
- `collectAnchorNumbers(ctx)` returns all safe date/event numbers that may appear in generated text.
- Retry instructions use the same reason vocabulary as the persisted statistics.

- [ ] **Step 1: Add failing regression tests**
  - A repeated common opening that is not an exact historical fingerprint should pass.
  - A date/event number supplied by `dateContext` or event phase should pass `ungrounded_number`.
  - An unrelated number must still fail.
  - Exact historical opening repetition, malformed JSON, wrong line count, too-short lines, and blocked content must still fail.

- [ ] **Step 2: Run focused tests and verify failure**
  Run: `node --test server/tests/cheer-stream-route.test.js server/tests/cheer-data-mode.test.js`
  Expected: new regression tests fail against current strict behavior.

- [ ] **Step 3: Implement the smallest validation change**
  - Keep exact historical opening fingerprints as the hard rejection case; do not reject merely because a common first character or short prefix appears.
  - Include event phase, date anchors, and existing references in the allowed-number set; do not accept arbitrary digits.
  - Ensure retry instructions mention the same exact reason and the concrete allowed numbers where applicable.

- [ ] **Step 4: Run focused and full tests**
  Run: `node --test server/tests/cheer-stream-route.test.js server/tests/cheer-data-mode.test.js` and `node --test server/tests/*.test.js`
  Expected: all tests pass.

- [ ] **Step 5: Commit**
  ```bash
  git add server/src/routes/cheer.js server/tests/cheer-stream-route.test.js server/tests/cheer-data-mode.test.js
  git commit -m "fix(ai): reduce false-positive cheer validation failures"
  ```

---

### Task 4: Build the admin reference panel

**Files:**
- Modify: `server/public/admin.html`
- Modify: `server/public/admin.js`
- Test: `server/tests/admin-ui.test.js` or existing admin static-asset test

**Interfaces:**
- The AI view loads `/api/admin/ai/stats` on refresh and view activation.
- The panel displays window selector (`24h`, `7d`, `30d`), model, samples, success rate, P50/P95, retry count, validation failures, and token usage.
- The current configuration form remains the only control that can change the model.

- [ ] **Step 1: Add failing static UI tests**
  - Assert the AI view has a stats container and window selector.
  - Assert the script requests `/api/admin/ai/stats` and renders the model rows.
  - Assert the panel has read-only text and does not contain a model mutation action.

- [ ] **Step 2: Run the focused test and verify failure**
  Run: `node --test server/tests/admin-ui.test.js`
  Expected: missing stats markup/request function.

- [ ] **Step 3: Implement the read-only panel**
  - Match existing admin DOM and CSS conventions.
  - Escape all values before inserting them into HTML.
  - Show an explicit empty state when no samples exist.
  - Keep the model dropdown and save/test controls unchanged.

- [ ] **Step 4: Run static UI and full backend tests**
  Run: `node --test server/tests/admin-ui.test.js` and `node --test server/tests/*.test.js`
  Expected: all tests pass.

- [ ] **Step 5: Commit**
  ```bash
  git add server/public/admin.html server/public/admin.js server/tests/admin-ui.test.js
  git commit -m "feat(admin): add AI model performance reference panel"
  ```

---

### Task 5: End-to-end verification and production sampling

**Files:**
- Modify: KB plan/daily log only after verification
- No source changes unless verification finds a defect

- [ ] **Step 1: Run repository checks**
  Run backend full tests, relevant frontend tests if present, and the repository lint command discovered from package scripts.
  Expected: no new failures; record pre-existing lint findings separately.

- [ ] **Step 2: Deploy the reviewed commits**
  Push to the configured release branch and verify the new Vercel deployment is Ready and aliased.

- [ ] **Step 3: Run 10 authenticated production samples**
  Use the existing test account without printing credentials; collect status, model, elapsed time, retries, validation reason, and usage from admin stats/logs.

- [ ] **Step 4: Compare acceptance metrics**
  Require no platform 300-second kills, P95 below 180 seconds, and report actual success rate and validation distribution. If success remains below 95%, leave model selection manual and document the remaining validator evidence rather than entering D3 automatically.

- [ ] **Step 5: Update documentation**
  Update the remediation plan with measured metrics and the admin stats reference behavior; update the current agent daily-log shard with a short pointer and handoff state.

- [ ] **Step 6: Commit and push knowledge-base changes**
  ```bash
  git add 01-Projects/01-Active/wuyan-cloudbase-project/plans/2026-09-24-cheer-stream-timeout-remediation-plan.md 04-Daily/logs/2026-09-24/opencode.md
  git commit -m "docs: record AI stats panel and validation results"
  git push origin
  ```
