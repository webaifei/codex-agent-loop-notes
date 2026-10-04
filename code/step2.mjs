/**
 * Step 2 — step 循环。
 *
 * 场景：模型说"我得先读一下 parseDate 的实现"，读完才能改。
 * 所以一轮对话里不止一次模型请求——读文件是一次，改代码是另一次。
 * 一次请求 = 一个 step。
 *
 * 对照 Codex：codex-rs/core/src/session/turn.rs
 *   let mut next_step_context = Some(first_step_context);   // L424
 *   loop {                                                   // L426
 *       ...
 *       let needs_follow_up = model_needs_follow_up || has_pending_input;   // L566
 *       ...
 *       if !needs_follow_up {                                // L653
 *           last_agent_message = ...;
 *           break;
 *       }
 *   }
 *
 * 运行：node code/step2.mjs
 */

const say = (depth, ...rest) => console.log('  '.repeat(depth) + rest.join(' '))

class InputQueue {
  #pending = []
  enqueue(text) {
    this.#pending.push(text)
  }
  hasPendingInput() {
    return this.#pending.length > 0
  }
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

/** 一个步骤的上下文：模型、工具集、沙箱策略……每一步捕获一次。 */
function captureStepContext(step) {
  return { step, capturedAt: Date.now() }
}

/**
 * 一次模型请求。
 * 返回 Codex 的 SamplingRequestResult：needs_follow_up + last_agent_message。
 *
 * 注意：模型不知道自己是第几个 step（stepContext 会被复用），
 * 所以这里按"第几次采样"来模拟，而不是按 step 号。
 */
let samplingCalls = 0

async function runSamplingRequest(stepContext) {
  samplingCalls += 1

  if (samplingCalls === 1) {
    // 模型决定先读文件
    const toolCall = { name: 'read_file', args: { path: 'src/parseDate.ts' } }
    say(3, `采样请求 → 模型要调工具 ${toolCall.name}(${toolCall.args.path})`)
    const result = 'export function parseDate(input: string) { /* 本地时区 */ }'
    say(3, `工具结果 → ${result}`)
    return { needsFollowUp: true, lastAgentMessage: null }
  }
  say(3, '采样请求 → 模型给出最终答案')
  return { needsFollowUp: false, lastAgentMessage: 'parseDate 用了本地时区，改成 UTC 解析即可。' }
}

async function runTurn(session, input) {
  const claimed = input.length > 0 ? input : session.inputQueue.takeOnePending()
  session.turnCount += 1
  const turn = session.turnCount
  session.append('turn/start', { turn })
  say(1, `turn/start {turn:${turn}}  input=${JSON.stringify(claimed)}`)

  let nextStepContext = null // 复用上一次捕获的上下文（Codex 的 next_step_context）
  let lastAgentMessage = null
  let step = 0

  for (;;) {
    step += 1
    // 有新的待处理输入就重新捕获，否则复用——避免每步都重算工具集和沙箱策略
    const stepContext = nextStepContext ?? captureStepContext(step)
    nextStepContext = null

    say(2, `step/start {step:${step}}`)
    const modelResult = await runSamplingRequest(stepContext)

    // ★ 这一行是 Codex 的 L566：模型说要不要继续，或者队列里又来了东西
    const needsFollowUp = modelResult.needsFollowUp || session.inputQueue.hasPendingInput()
    say(2, `step/end  needs_follow_up=${needsFollowUp}（模型=${modelResult.needsFollowUp}）`)

    if (!needsFollowUp) {
      lastAgentMessage = modelResult.lastAgentMessage
      break
    }
    nextStepContext = stepContext
  }

  session.append('turn/end', { turn })
  say(1, 'turn/end')
  return lastAgentMessage
}

async function runTask(session, input) {
  let nextInput = input
  for (;;) {
    const lastAgentMessage = await runTurn(session, nextInput)
    if (session.terminalError !== null) return lastAgentMessage
    if (!session.inputQueue.hasPendingInput()) return lastAgentMessage
    nextInput = []
  }
}

// ── 场景：一轮对话里两次模型请求 ──────────────────────────────────────
const session = new Session()
say(0, '【读文件 → 改代码，一轮里两步】')
const answer = await runTask(session, ['修一下 parseDate 的时区问题'])
say(0, `最终回复：${answer}`)
