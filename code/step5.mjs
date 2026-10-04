/**
 * Step 5 — 取消怎么传播。
 *
 * 场景：你按了 Ctrl+C。此刻可能同时跑着：主任务的采样请求、一轮对话的收尾、
 * 一个工具子进程。全部要停，但不能用十几个全局标志位去管。
 *
 * Codex 的答案是从父到子派生 token，取消自动向下传播：
 *   cancellation_token.child_token()
 *   .or_cancel(&cancellation_token)
 *
 * 对照 Codex：tokio_util::sync::CancellationToken 的用法贯穿 turn.rs
 *   L1709  cancellation_token.child_token()          每个步骤一个子 token
 *   L1742  .or_cancel(&preempt)                     任务与取消谁先到用谁
 *   L1743  .or_cancel(&cancellation_token)
 *
 * 运行：node code/step5.mjs
 */

const say = (depth, ...rest) => console.log('  '.repeat(depth) + rest.join(' '))

class CancelledError extends Error {
  constructor() {
    super('cancelled')
    this.name = 'CancelledError'
  }
}

/**
 * 等价于 Rust 的 CancellationToken。
 * 关键在 cancel()：取消自己，并把取消向下传给所有子 token。
 */
class CancellationToken {
  #controller = new AbortController()
  #children = new Set()
  #label

  constructor(label = 'root') {
    this.#label = label
  }

  /** 派生一个子 token。父被取消时，子自动跟着取消。 */
  childToken(label) {
    const child = new CancellationToken(label)
    this.#children.add(child)
    return child
  }

  cancel() {
    if (this.#controller.signal.aborted) return
    this.#controller.abort()
    for (const child of this.#children) child.cancel()
  }

  get isCancelled() {
    return this.#controller.signal.aborted
  }

  get label() {
    return this.#label
  }

  /** Codex 的 or_cancel：任务先完成就用任务的结果，token 先取消就抛取消。 */
  async orCancel(promise) {
    if (this.isCancelled) throw new CancelledError()
    const cancelled = new Promise((_, reject) => {
      this.#controller.signal.addEventListener('abort', () => reject(new CancelledError()), { once: true })
    })
    return await Promise.race([promise, cancelled])
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 模拟一个跑得比较久的采样请求。 */
async function longSamplingRequest(token, name) {
  say(3, `${name} 开始（token=${token.label}）`)
  await sleep(120)
  // 取消已经发生的话，就别再报"完成"了——真实系统里这时连接早就断了
  if (token.isCancelled) return `${name} 被取消`
  say(3, `${name} 完成`)
  return `${name} 的结果`
}

async function runStep(stepToken, name) {
  try {
    const result = await stepToken.orCancel(longSamplingRequest(stepToken, name))
    return { result }
  } catch (err) {
    if (err instanceof CancelledError) return { cancelled: true }
    throw err
  }
}

// ── 场景 A：只取消当前这一轮，任务本身还活着 ─────────────────────────
say(0, '【场景 A · 取消当前轮，不取消整个任务】')
{
  const taskToken = taskRoot('task')
  const turnToken = taskToken.childToken('turn')
  const stepToken = turnToken.childToken('step-1')

  const running = runStep(stepToken, '采样请求')
  await sleep(40)
  say(3, '→ 用户取消这一轮')
  turnToken.cancel() // 只取消这一轮

  const outcome = await running
  say(2, `步骤结果：${outcome.cancelled ? '已取消' : outcome.result}`)
  say(2, `轮次 token  : ${turnToken.isCancelled ? '已取消' : '活着'}`)
  say(2, `步骤 token  : ${stepToken.isCancelled ? '已取消（跟着父一起）' : '活着'}`)
  say(2, `任务 token  : ${taskToken.isCancelled ? '已取消' : '仍然活着 → 可以开始新一轮'}`)
}

say(0, '')

// ── 场景 B：取消根 token，所有子 token 一起停 ────────────────────────
say(0, '【场景 B · 取消整个任务】')
{
  const taskToken = taskRoot('task')
  const turnToken = taskToken.childToken('turn')
  const stepToken = turnToken.childToken('step-1')

  const running = runStep(stepToken, '采样请求')
  await sleep(40)
  say(3, '→ 用户按了 Ctrl+C')
  taskToken.cancel() // 取消根

  await running
  say(2, `任务 token  : ${taskToken.isCancelled ? '已取消' : '活着'}`)
  say(2, `轮次 token  : ${turnToken.isCancelled ? '已取消' : '活着'}`)
  say(2, `步骤 token  : ${stepToken.isCancelled ? '已取消' : '活着'}`)
  say(2, '（三个都是"已取消"——取消自己传播下去了）')
}

function taskRoot(label) {
  const token = new CancellationToken(label)
  say(2, `建立 ${label} token`)
  return token
}
