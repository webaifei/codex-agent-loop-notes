/**
 * Step 1 — turn 循环。
 *
 * 场景：你在终端里让 codex 改个 bug，它干活的时候你又敲了一句补充。
 * 这两句话不该一起处理，否则模型分不清哪句对应哪次回复。
 * 所以轮次边界一次只领一句，做完这一轮再看队列里还有没有。
 *
 * 对照 Codex：codex-rs/core/src/tasks/regular.rs 的 RegularTask::run
 *   loop {
 *       run_turn(...).await?;
 *       if ctx.terminal_error ... { return }
 *       if !sess.input_queue.has_pending_input(...) { return }
 *       next_input = Vec::new();
 *   }
 *
 * 运行：node code/step1.mjs
 */

const say = (depth, ...rest) => console.log('  '.repeat(depth) + rest.join(' '))

/** 待处理输入队列。Codex 里是 810 行的 InputQueue，这里先留最小的形状。 */
class InputQueue {
  #pending = []

  enqueue(text) {
    this.#pending.push(text)
  }

  /** 还有没有活。这是主循环唯一的出口条件。 */
  hasPendingInput() {
    return this.#pending.length > 0
  }

  /** 轮次边界只领一条——连发三条，就该有三个 turn。 */
  takeOnePending() {
    return this.#pending.splice(0, 1)
  }
}

class Session {
  constructor() {
    this.inputQueue = new InputQueue()
    this.turnCount = 0
    this.terminalError = null
    this.log = []
  }

  append(type, data = {}) {
    this.log.push({ type, ...data })
  }
}

/**
 * 一轮：把这一轮的输入发给模型，拿到回复。
 * input 为空表示"这一轮的输入要去队列里领"。
 */
async function runTurn(session, input) {
  const claimed = input.length > 0 ? input : session.inputQueue.takeOnePending()

  session.turnCount += 1
  const turn = session.turnCount
  session.append('turn/start', { turn })
  say(1, `turn/start {turn:${turn}}  input=${JSON.stringify(claimed)}`)

  const lastAgentMessage = `收到：${claimed.join(' / ')}`
  session.append('turn/end', { turn })
  say(1, 'turn/end')
  return lastAgentMessage
}

/**
 * Codex 的 RegularTask::run —— agent 的主循环。
 * 每转一圈 = 一个 turn。
 */
async function runTask(session, input) {
  let nextInput = input
  for (;;) {
    const lastAgentMessage = await runTurn(session, nextInput)

    // 已经上报过的致命错误，不拿同一份输入重启失败的轮次
    if (session.terminalError !== null) return lastAgentMessage

    // 队列空了 → 整个任务结束
    if (!session.inputQueue.hasPendingInput()) return lastAgentMessage

    nextInput = [] // 后续轮次的输入来自队列，不再复用最初的 input
  }
}

// ── 场景：第一条正在处理时，用户又补了一句 ───────────────────────────
const session = new Session()
session.inputQueue.enqueue('顺便把测试补上') // ← 处理期间到达的第二条

say(0, '【改 bug + 中途补一句】')
const answer = await runTask(session, ['修一下 parseDate 的时区问题'])
say(0, `最后一条回复：${answer}`)
say(0, `一共跑了 ${session.turnCount} 个 turn`)
