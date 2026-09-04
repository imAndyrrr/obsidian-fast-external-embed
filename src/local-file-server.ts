import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { randomBytes } from "crypto";
import type { AddressInfo } from "net";

interface LocalResource {
  id: string;
  filePath: string;
  mimeType: string;
}

interface ByteRange {
  start: number;
  end: number;
}

/**
 * Exposes explicitly registered local files through a loopback-only HTTP server.
 *
 * Chromium's PDF viewer can issue HTTP Range requests against this endpoint,
 * so a PDF no longer has to be copied into one complete in-memory Blob before
 * its first page can be displayed.
 */
export class LocalFileServer {
  private readonly sessionToken = randomBytes(24).toString("hex");
  private readonly resourcesById = new Map<string, LocalResource>();
  private readonly resourceIdByPath = new Map<string, string>();
  private readonly activeStreams = new Set<fs.ReadStream>();
  private server: http.Server | null = null;
  private startPromise: Promise<number> | null = null;
  private port: number | null = null;

  public async getFileUrl(filePath: string, mimeType: string): Promise<string> {
    const normalizedPath = path.resolve(filePath);
    const stat = await fs.promises.stat(normalizedPath);
    if (!stat.isFile()) {
      throw new Error(`路径不是文件: ${normalizedPath}`);
    }

    let id = this.resourceIdByPath.get(normalizedPath);
    if (!id) {
      id = randomBytes(18).toString("hex");
      this.resourceIdByPath.set(normalizedPath, id);
      this.resourcesById.set(id, {
        id,
        filePath: normalizedPath,
        mimeType,
      });
    } else {
      const resource = this.resourcesById.get(id);
      if (resource) resource.mimeType = mimeType;
    }

    const port = await this.ensureStarted();
    const encodedName = encodeURIComponent(path.basename(normalizedPath));
    return `http://127.0.0.1:${port}/resource/${this.sessionToken}/${id}/${encodedName}`;
  }

  public cleanup(): void {
    for (const stream of this.activeStreams) {
      stream.destroy();
    }
    this.activeStreams.clear();

    if (this.server) {
      this.server.close();
      this.server = null;
    }

    this.startPromise = null;
    this.port = null;
    this.resourcesById.clear();
    this.resourceIdByPath.clear();
  }

  private ensureStarted(): Promise<number> {
    if (this.port !== null) return Promise.resolve(this.port);
    if (this.startPromise) return this.startPromise;

    this.startPromise = new Promise<number>((resolve, reject) => {
      const server = http.createServer((request, response) => {
        void this.handleRequest(request, response);
      });

      server.on("clientError", (_error, socket) => {
        socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      });

      const fail = (error: Error) => {
        server.close();
        this.server = null;
        this.startPromise = null;
        reject(error);
      };

      server.once("error", fail);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", fail);
        server.on("error", (error) => {
          console.error("Fast External Embed local server error:", error);
        });

        const address = server.address() as AddressInfo | null;
        if (!address || typeof address.port !== "number") {
          fail(new Error("无法取得本地文件服务端口"));
          return;
        }

        this.server = server;
        this.port = address.port;
        server.unref();
        resolve(address.port);
      });
    });

    return this.startPromise;
  }

  private async handleRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    try {
      if (request.method === "OPTIONS") {
        response.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "Range, Content-Type",
          "Access-Control-Max-Age": "86400",
        });
        response.end();
        return;
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { Allow: "GET, HEAD, OPTIONS" });
        response.end();
        return;
      }

      const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
      const parts = requestUrl.pathname.split("/").filter(Boolean);
      if (
        parts.length < 3 ||
        parts[0] !== "resource" ||
        parts[1] !== this.sessionToken
      ) {
        this.sendNotFound(response);
        return;
      }

      const resource = this.resourcesById.get(parts[2]);
      if (!resource) {
        this.sendNotFound(response);
        return;
      }

      const stat = await fs.promises.stat(resource.filePath);
      if (!stat.isFile()) {
        this.sendNotFound(response);
        return;
      }

      const size = stat.size;
      const etag = `"${size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
      const commonHeaders: http.OutgoingHttpHeaders = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=0, must-revalidate",
        "Content-Type": resource.mimeType,
        "Content-Disposition": this.createInlineDisposition(resource.filePath),
        ETag: etag,
        "Last-Modified": stat.mtime.toUTCString(),
        "X-Content-Type-Options": "nosniff",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers":
          "Accept-Ranges, Content-Length, Content-Range, ETag, Last-Modified",
        "Cross-Origin-Resource-Policy": "cross-origin",
      };

      if (request.headers["if-none-match"] === etag && !request.headers.range) {
        response.writeHead(304, commonHeaders);
        response.end();
        return;
      }

      let range: ByteRange | null = null;
      if (request.headers.range) {
        range = this.parseRange(request.headers.range, size);
        if (!range) {
          response.writeHead(416, {
            ...commonHeaders,
            "Content-Range": `bytes */${size}`,
          });
          response.end();
          return;
        }
      }

      const start = range?.start ?? 0;
      const end = range?.end ?? Math.max(size - 1, 0);
      const contentLength = size === 0 ? 0 : end - start + 1;
      const status = range ? 206 : 200;
      const headers: http.OutgoingHttpHeaders = {
        ...commonHeaders,
        "Content-Length": contentLength,
      };
      if (range) {
        headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
      }

      response.writeHead(status, headers);
      if (request.method === "HEAD" || size === 0) {
        response.end();
        return;
      }

      const stream = fs.createReadStream(resource.filePath, { start, end });
      this.activeStreams.add(stream);
      const forgetStream = () => this.activeStreams.delete(stream);
      stream.once("close", forgetStream);
      stream.once("error", (error) => {
        forgetStream();
        if (!response.destroyed) response.destroy(error);
      });
      response.once("close", () => {
        if (!stream.destroyed) stream.destroy();
      });
      stream.pipe(response);
    } catch (error: any) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        this.sendNotFound(response);
        return;
      }

      console.error("Fast External Embed local file request error:", error);
      if (!response.headersSent) {
        response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Unable to read local file");
      } else if (!response.destroyed) {
        response.destroy(error);
      }
    }
  }

  private parseRange(header: string, size: number): ByteRange | null {
    if (size <= 0) return null;

    const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
    if (!match || (!match[1] && !match[2])) return null;

    if (!match[1]) {
      const suffixLength = Number(match[2]);
      if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
      return {
        start: Math.max(size - suffixLength, 0),
        end: size - 1,
      };
    }

    const start = Number(match[1]);
    const requestedEnd = match[2] ? Number(match[2]) : size - 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(requestedEnd) ||
      start < 0 ||
      requestedEnd < start ||
      start >= size
    ) {
      return null;
    }

    return {
      start,
      end: Math.min(requestedEnd, size - 1),
    };
  }

  private createInlineDisposition(filePath: string): string {
    const fallback = path.basename(filePath).replace(/[^\x20-\x7E]/g, "_");
    const encoded = encodeURIComponent(path.basename(filePath));
    return `inline; filename="${fallback.replace(/["\\]/g, "_")}"; filename*=UTF-8''${encoded}`;
  }

  private sendNotFound(response: http.ServerResponse): void {
    if (response.headersSent) {
      response.end();
      return;
    }
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}
