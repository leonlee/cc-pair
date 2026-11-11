import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_ANSWER_BYTES = 4 * 1024 * 1024;

/** The control socket of Codex's shared app-server daemon, which the Codex TUI runs its sessions on. */
export function codexControlSocket(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CODEX_HOME || join(homedir(), ".codex"), "app-server-control", "app-server-control.sock");
}

/** One masked client text frame (RFC 6455). */
function frame(text: string): Buffer {
  const payload = Buffer.from(text);
  const mask = randomBytes(4);
  const length = payload.length;
  const head = length < 126 ? Buffer.from([0x81, 0x80 | length])
    : length < 65536 ? Buffer.from([0x81, 0x80 | 126, length >> 8, length & 0xff])
      : Buffer.concat([Buffer.from([0x81, 0x80 | 127]), (() => { const size = Buffer.alloc(8); size.writeBigUInt64BE(BigInt(length)); return size; })()]);
  return Buffer.concat([head, mask, payload.map((byte, index) => byte ^ mask[index % 4])]);
}

/**
 * The thread IDs the running Codex daemon has loaded, from `thread/loaded/list` over its control
 * socket, which speaks JSON-RPC over WebSocket. Read-only: it never starts a daemon or resumes a thread.
 * ponytail: a minimal WebSocket client (no fragmentation, no pong); Node has none for Unix sockets.
 */
export function loadedThreads(socketPath: string = codexControlSocket(), timeoutMs = 3000): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const threads: string[] = [];
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    let listId = 2;
    let socket: ReturnType<typeof connect>;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      if (error) reject(error);
      else resolve(threads);
    };
    const timer = setTimeout(() => finish(new Error(`no answer within ${timeoutMs / 1000}s`)), timeoutMs);
    const send = (message: object): void => { socket.write(frame(JSON.stringify(message))); };
    const list = (cursor?: string): void => send({ id: listId, method: "thread/loaded/list", params: cursor ? { cursor } : {} });
    const answer = (text: string): void => {
      const message = JSON.parse(text) as { id?: unknown; error?: { message?: unknown }; result?: { data?: unknown; nextCursor?: unknown } };
      if (message.id !== 1 && message.id !== listId) return; // a notification, or another client's business
      if (message.error) return finish(new Error(`the app-server answered: ${String(message.error.message ?? "an error")}`));
      if (message.id === 1) {
        send({ method: "initialized" });
        return list();
      }
      const { data, nextCursor } = message.result ?? {};
      if (!Array.isArray(data) || !data.every((id) => typeof id === "string")) return finish(new Error("unexpected thread/loaded/list answer"));
      threads.push(...data);
      if (typeof nextCursor !== "string") return finish();
      listId += 1;
      list(nextCursor);
    };
    try {
      socket = connect(realpathSync(socketPath)); // the real path: a socket path is limited to about 104 bytes
    } catch (error) {
      return finish(error as Error);
    }
    socket.on("error", (error) => finish(error));
    socket.on("close", () => finish(new Error("the app-server closed the connection")));
    socket.on("connect", () => {
      socket.write(`GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\n\r\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_ANSWER_BYTES) return finish(new Error("the app-server's answer is too large"));
      try {
        if (!upgraded) {
          const end = buffer.indexOf("\r\n\r\n");
          if (end < 0) return;
          if (!buffer.subarray(0, end).toString().startsWith("HTTP/1.1 101")) return finish(new Error("the app-server refused the WebSocket upgrade"));
          upgraded = true;
          buffer = buffer.subarray(end + 4);
          send({ id: 1, method: "initialize", params: { clientInfo: { name: "pair", version: "1" } } });
        }
        while (buffer.length >= 2 && !settled) {
          let length = buffer[1] & 0x7f;
          let offset = 2;
          if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
          else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
          if (buffer[1] & 0x80) return finish(new Error("the app-server sent a masked frame"));
          if (buffer.length < offset + length) return;
          const fin = (buffer[0] & 0x80) !== 0;
          const opcode = buffer[0] & 0x0f;
          const payload = buffer.subarray(offset, offset + length);
          buffer = buffer.subarray(offset + length);
          if (opcode === 8) return finish(new Error("the app-server closed the connection"));
          if (opcode === 0 || (opcode === 1 && !fin)) return finish(new Error("the app-server sent a fragmented message"));
          if (opcode === 1) answer(payload.toString());
        }
      } catch (error) {
        finish(error as Error);
      }
    });
  });
}
