/**
 * A minimal JSON-RPC client for `tsc --lsp --stdio` (TS 7's built-in language server), enough to ask for the
 * same hover text an editor shows (D31, C11). Every request has a timeout, a dead server fails every pending
 * request, and `shutdown` always leaves no child process behind.
 */
import { spawn } from "node:child_process"
import { Schema } from "effect"

/** The envelope of any message the server sends. */
const Envelope = Schema.Struct({
  id: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String, Schema.Null])),
  method: Schema.optionalKey(Schema.String),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Struct({ code: Schema.Number, message: Schema.String }))
})
const decodeEnvelope = Schema.decodeUnknownSync(Schema.fromJsonString(Envelope))

/** A running language server. */
export interface LspClient {
  /**
   * Sends a request and resolves with its `result`; rejects on an error response, a timeout or a dead server.
   * Requests without parameters (such as `shutdown`) must omit them: the server rejects `params: null`.
   */
  readonly request: (method: string, params?: object) => Promise<unknown>
  /** Sends a notification. */
  readonly notify: (method: string, params: object) => void
  /** Asks the server to shut down and exit, and kills it if it does not exit in time. Never rejects. */
  readonly shutdown: () => Promise<void>
}

interface Pending {
  readonly method: string
  readonly resolve: (result: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

const headerSeparator = "\r\n\r\n"
const maxStderr = 4096

/** Starts `binary --lsp --stdio` in `cwd`. Each request times out after `timeoutMs`. */
export const startLsp = (binary: string, cwd: string, timeoutMs: number): LspClient => {
  const child = spawn(binary, ["--lsp", "--stdio"], { cwd, stdio: ["pipe", "pipe", "pipe"] })
  const pending = new Map<number, Pending>()
  let stderr = ""
  let dead: Error | undefined
  let buffer = Buffer.alloc(0)
  let nextId = 1

  const failAll = (error: Error): void => {
    dead ??= error
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    pending.clear()
  }
  const exited = new Promise<void>((resolve) => {
    child.on("exit", (code, signal) => {
      failAll(new Error(`the language server exited (code ${code}, signal ${signal})${stderr === "" ? "" : `; stderr: ${stderr}`}`))
      resolve()
    })
  })
  child.on("error", (error) => failAll(error))
  child.stdin.on("error", (error) => failAll(error))
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-maxStderr)
  })

  const write = (message: object): void => {
    if (dead !== undefined) return
    const body = JSON.stringify({ jsonrpc: "2.0", ...message })
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}${headerSeparator}${body}`)
  }

  const onMessage = (body: string): void => {
    const message = decodeEnvelope(body)
    const id = message.id
    if (message.method !== undefined) {
      // A server-to-client request (workspace/configuration, capability registration, progress): accept it
      // with an empty result. Notifications (logs, diagnostics) need no answer.
      if (id !== undefined) write({ id, result: null })
      return
    }
    if (typeof id !== "number") return
    const entry = pending.get(id)
    if (entry === undefined) return
    pending.delete(id)
    clearTimeout(entry.timer)
    if (message.error !== undefined) entry.reject(new Error(`${entry.method} failed: ${message.error.message} (${message.error.code})`))
    else entry.resolve(message.result)
  }

  child.stdout.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      const separator = buffer.indexOf(headerSeparator)
      if (separator < 0) return
      const length = /Content-Length: (\d+)/i.exec(buffer.subarray(0, separator).toString("utf8"))?.[1]
      if (length === undefined) {
        failAll(new Error("the language server sent a message without Content-Length"))
        child.kill()
        return
      }
      const start = separator + headerSeparator.length
      const end = start + Number(length)
      if (buffer.length < end) return
      const body = buffer.subarray(start, end).toString("utf8")
      buffer = buffer.subarray(end)
      try {
        onMessage(body)
      } catch (cause) {
        failAll(new Error("the language server sent a malformed message", { cause }))
        child.kill()
        return
      }
    }
  })

  const request = (method: string, params?: object): Promise<unknown> =>
    new Promise<unknown>((resolve, reject) => {
      if (dead !== undefined) {
        reject(dead)
        return
      }
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`${method} timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      pending.set(id, { method, resolve, reject, timer })
      write(params === undefined ? { id, method } : { id, method, params })
    })

  const shutdown = async (): Promise<void> => {
    try {
      await request("shutdown")
      write({ method: "exit" })
    } catch {
      // The server is already gone or unresponsive; it is killed below either way.
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs)
    })
    const outcome = await Promise.race([exited.then(() => "exited" as const), timedOut])
    clearTimeout(timer)
    if (outcome === "timeout") {
      child.kill("SIGKILL")
      await exited
    }
  }

  return { request, notify: (method, params) => write({ method, params }), shutdown }
}
