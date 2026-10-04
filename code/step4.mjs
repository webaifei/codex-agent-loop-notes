/**
 * Step 4 — 重试循环与错误分类。
 *
 * 场景：网络抖了一下，请求断了。重发一次没问题。
 * 但如果断的原因是"上下文超了"或者"额度用完了"，重发一百次也没用，
 * 只会浪费你的钱和时间。所以重试之前必须先分类。
 *
 * 对照 Codex：codex-rs/core/src/session/turn.rs L1663-1758
 *   let max_retries = turn_context.provider.info().stream_max_retries();   // 由 provider 决定
 *   loop {
 *       match try_run_sampling_request(...) {
 *           Ok(output) => return ...,
 *           Err(err) => match err.details() {
 *               ContextWindowExceeded => return Err(err),   // 不重试
 *               UsageLimitReached(_)  => return Err(err),   // 不重试
 *               _ => err,
 *           },
 *       }
 *       let retry = handle_response_stream_error(&mut retry_state, max_retries, err, ...).await?;
 *       retry??;
 *   }
 *
 * 运行：node code/step4.mjs
 */

const say = (depth, ...rest) => console.log('  '.repeat(depth) + rest.join(' '))

/** Codex 的错误带着 details()，用它来分类，而不是靠错误消息文本。 */
const ErrorDetails = {
  ContextWindowExceeded: 'context_window_exceeded',
  UsageLimitReached: 'usage_limit_reached',
  Stream: 'stream',
}

class CodexError extends Error {
  #details
  constructor(message, details) {
    super(message)
    this.#details = details
  }
  details() {
    return this.#details
  }
}

/** provider 自己声明能重试几次——不是全局常量。 */
const providerInfo = { name: 'openai', streamMaxRetries: 3 }

/** Codex 的 ResponsesStreamRetryState。这里只留重试计数。 */
class RetryState {
  attempts = 0
}

/**
 * 一次采样请求。用注入的 failurePlan 模拟不同的失败方式。
 * 返回 { ok: true, output } 或抛出 CodexError。
 */
function makeSamplingRequest(failurePlan) {
  let calls = 0
  return async function tryRunSamplingRequest() {
    calls += 1
    const failure = failurePlan(calls)
    if (failure) throw new CodexError(failure.message, failure.details)
    return { lastAgentMessage: '改好了。' }
  }
}

/**
 * Codex 的采样重试循环。
 * 返回值：{ output } 或 { error }——不抛异常，调用方看返回值决定怎么收尾。
 */
async function runSamplingWithRetry(tryRunSamplingRequest) {
  const maxRetries = providerInfo.streamMaxRetries
  const retryState = new RetryState()

  for (;;) {
    try {
      const output = await tryRunSamplingRequest()
      return { output }
    } catch (err) {
      // ── 先分类：有些错误重试没有意义 ──────────────────────────────
      switch (err.details()) {
        case ErrorDetails.ContextWindowExceeded:
          say(3, `错误分类：上下文超限 → 立即放弃，不重试`)
          return { error: err }
        case ErrorDetails.UsageLimitReached:
          say(3, `错误分类：额度用尽 → 立即放弃，不重试`)
          return { error: err }
        default:
          break
      }

      // ── 可重试的错误：看还有没有额度 ──────────────────────────────
      retryState.attempts += 1
      if (retryState.attempts > maxRetries) {
        say(3, `重试 ${maxRetries} 次仍未成功 → 放弃`)
        return { error: err }
      }
      say(3, `可重试错误（${err.details()}）→ 第 ${retryState.attempts}/${maxRetries} 次重试`)
    }
  }
}

// ── 场景 A：网络抖动，重试后成功 ─────────────────────────────────────
say(0, '【场景 A · 前两次流断了，第三次成功】')
{
  const request = makeSamplingRequest((call) =>
    call <= 2 ? { message: 'stream disconnected', details: ErrorDetails.Stream } : null,
  )
  const { output, error } = await runSamplingWithRetry(request)
  say(1, output ? `结果：${output.lastAgentMessage}` : `失败：${error.message}`)
}

say(0, '')

// ── 场景 B：上下文超限，一次都不重试 ─────────────────────────────────
say(0, '【场景 B · 上下文超限】')
{
  const request = makeSamplingRequest(() => ({
    message: 'context window exceeded',
    details: ErrorDetails.ContextWindowExceeded,
  }))
  const { output, error } = await runSamplingWithRetry(request)
  say(1, output ? `结果：${output.lastAgentMessage}` : `失败：${error.message}`)
}

say(0, '')
say(0, '对比：场景 A 打了 3 次请求，场景 B 只打了 1 次。')
