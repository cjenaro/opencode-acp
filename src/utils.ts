import { Readable, Writable } from "node:stream";

export function nodeToWebReadable(nodeStream: Readable): ReadableStream {
  return new ReadableStream({
    start(controller) {
      nodeStream.on("data", (chunk) => {
        controller.enqueue(chunk);
      });
      nodeStream.on("end", () => {
        controller.close();
      });
      nodeStream.on("error", (err) => {
        controller.error(err);
      });
    },
    cancel() {
      nodeStream.destroy();
    },
  });
}

export function nodeToWebWritable(nodeStream: Writable): WritableStream {
  return new WritableStream({
    write(chunk) {
      return new Promise((resolve, reject) => {
        nodeStream.write(chunk, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        nodeStream.end((err: Error | undefined) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
    abort(reason) {
      nodeStream.destroy(reason);
    },
  });
}

export function unreachable(x: never): never {
  throw new Error(`Unreachable code reached: ${x}`);
}
