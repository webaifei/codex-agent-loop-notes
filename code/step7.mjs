/**
 * Step 7 — 让模型写程序调工具（code mode）。
 *
 * 场景：模型要在仓库里找一处用法，再读那个文件，再数行数。
 * 传统的做法是发三个 tool call，每次都要等一轮模型响应——三次往返。
 * Code mode 让模型发一段程序，一次跑完。
 *
 * 但程序可能跑很久，或者卡在某个工具调用上。所以 Codex 的 cell 可以挂起：
 * 先返回 Pending，等宿主准备好再 Wait 回来继续。
 *
 * 对照 Codex：
 *   codex-rs/code-mode-protocol/src/runtime.rs
 *     ExecuteRequest { tool_call_id, enabled_tools, source, yield_time_ms, max_output_tokens }
 *     ExecuteToPendingOutcome::Pending { cell_id, content_items, pending_tool_call_ids }
 *     WaitRequest { cell_id, yield_time_ms }
 *   运行时在 V8 里执行：codex-rs/code-mode-runtime/src/v8_init.rs
 *
 * 运行：node code/step7.mjs
 */

const say = (depth, ...rest) => console.log('  '.repeat(depth) + rest.join(' '))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const DEFAULT_EXEC_YIELD_TIME_MS = 500 // 真实值是 10_000，这里缩短好观察
const DEFAULT_MAX_OUTPUT_TOKENS_PER_EXEC_CALL = 10_000

/** 宿主提供给程序调用的工具。 */
const HOST_TOOLS = {
  grep: async (args) => {
    await sleep(60)
    return { matches: [`src/parseDate.ts:12`, `src/format.ts:3`] }
  },
  read_file: async (args) => {
    await sleep(800) // ← 故意比 yield_time_ms 慢，用来触发 Pending
    return { path: args.path, lines: 42 }
  },
}

/** 把启用的工具包装成程序里的一个全局对象。 */
let callSeq = 0

function buildBindings(enabledTools, pendingCalls, logs) {
  const tools = {}
  for (const name of enabledTools) {
    tools[name] = async (args) => {
      const callId = `call_${++callSeq}`
      pendingCalls.push(callId)
      say(4, `  [程序] 调用 ${name}(${JSON.stringify(args)}) → ${callId}`)
      logs.push(`[${name}] ${JSON.stringify(args)}`)
      const result = await HOST_TOOLS[name](args)
      pendingCalls.splice(pendingCalls.indexOf(callId), 1)
      return result
    }
  }
  return { tools }
}

/** 程序以 async 函数体执行：顶层 await 和 return 都可用。 */
function compile(source) {
  return new Function('tools', 'console', `return (async () => { ${source} })()`)
}

class CodeModeRuntime {
  #cells = new Map()
  #next = 0

  /** ExecuteRequest → Completed | Pending */
  execute({ toolCallId, enabledTools, source, yieldTimeMs = DEFAULT_EXEC_YIELD_TIME_MS }) {
    const cellId = `cell_${++this.#next}`
    const pendingCalls = []
    const logs = []
    const bindings = buildBindings(enabledTools, pendingCalls, logs)
    const sandboxConsole = { log: (...a) => { logs.push(a.join(' ')); say(4, `  [程序] ${a.join(' ')}`) } }

    const run = compile(source)(bindings.tools, sandboxConsole)
    this.#cells.set(cellId, { run, pendingCalls, logs, toolCallId })
    say(2, `execute { tool_call_id: ${toolCallId}, enabled_tools: ${JSON.stringify(enabledTools)}, yield_time_ms: ${yieldTimeMs} }`)
    return this.#settle(cellId, yieldTimeMs)
  }

  /** WaitRequest → Completed | Pending */
  wait({ cellId, yieldTimeMs = DEFAULT_EXEC_YIELD_TIME_MS }) {
    say(2, `wait { cell_id: ${cellId}, yield_time_ms: ${yieldTimeMs} }`)
    return this.#settle(cellId, yieldTimeMs)
  }

  async #settle(cellId, yieldTimeMs) {
    const cell = this.#cells.get(cellId)
    if (!cell) return { kind: 'MissingCell', cellId }

    const raced = await Promise.race([
      cell.run.then(
        (value) => ({ done: true, value }),
        (error) => ({ done: true, error: String(error) }),
      ),
      sleep(yieldTimeMs).then(() => ({ done: false })),
    ])

    if (!raced.done) {
      // 程序还没跑完 → 交回控制权，告诉宿主还在等哪些调用
      return {
        kind: 'Pending',
        cellId,
        content_items: [...cell.logs],
        pending_tool_call_ids: [...cell.pendingCalls],
      }
    }

    this.#cells.delete(cellId)
    return { kind: 'Completed', cellId, value: raced.value, error: raced.error, logs: cell.logs }
  }
}

// ── 场景 A：程序很短，一次跑完 ────────────────────────────────────────
say(0, '【场景 A · 一次跑完】')
{
  const runtime = new CodeModeRuntime()
  // 注意：模型发的是一段【程序】，不是一个个 tool call
  const source = `
    const hits = await tools.grep({ pattern: 'parseDate' })
    console.log('找到 ' + hits.matches.length + ' 处')
    return hits.matches.length
  `
  const outcome = await runtime.execute({ toolCallId: 'call_a', enabledTools: ['grep', 'read_file'], source })
  say(1, `结果：${outcome.kind}  value=${outcome.value}`)
}

say(0, '')

// ── 场景 B：程序卡在慢工具上，先 Pending，再 Wait 回来 ────────────────
say(0, '【场景 B · 挂起再恢复】')
{
  const runtime = new CodeModeRuntime()
  const source = `
    const hits = await tools.grep({ pattern: 'parseDate' })
    const file = await tools.read_file({ path: hits.matches[0] })
    console.log('这个文件 ' + file.lines + ' 行')
    return file.lines
  `
  const first = await runtime.execute({ toolCallId: 'call_b', enabledTools: ['grep', 'read_file'], source })
  say(1, `结果：${first.kind}  pending_tool_call_ids=${JSON.stringify(first.pending_tool_call_ids)}`)
  say(1, '→ 宿主可以把控制权交回给模型，也可以继续等')

  // 宿主决定继续等同一个 cell
  let outcome = first
  while (outcome.kind === 'Pending') {
    outcome = await runtime.wait({ cellId: first.cellId, yieldTimeMs: 500 })
  }
  say(1, `最终：${outcome.kind}  value=${outcome.value}`)
}
