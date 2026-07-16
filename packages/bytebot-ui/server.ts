import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { createProxyServer } from "http-proxy";
import next from "next";
import { createServer } from "http";
import dotenv from "dotenv";
import { Readable } from "stream";

// Load environment variables
dotenv.config();

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOSTNAME || "localhost";
const port = parseInt(process.env.PORT || "9992", 10);

// Backend URLs
const BYTEBOT_AGENT_BASE_URL = process.env.BYTEBOT_AGENT_BASE_URL;
const BYTEBOT_DESKTOP_VNC_URL = process.env.BYTEBOT_DESKTOP_VNC_URL;

const app = next({ dev, hostname, port });

app
  .prepare()
  .then(() => {
    const handle = app.getRequestHandler();
    const nextUpgradeHandler = app.getUpgradeHandler();

    const vncProxy = createProxyServer({ changeOrigin: true, ws: true });
    const desktopTargetUrl = new URL(BYTEBOT_DESKTOP_VNC_URL!);
    const desktopOrigin = `${desktopTargetUrl.protocol}//${desktopTargetUrl.host}`;

    const expressApp = express();
    const server = createServer(expressApp);

    // WebSocket proxy for Socket.IO connections to backend
    const tasksProxy = createProxyMiddleware({
      target: BYTEBOT_AGENT_BASE_URL,
      ws: true,
      pathRewrite: { "^/api/proxy/tasks": "/socket.io" },
    });

    // Apply HTTP proxies
    expressApp.use("/api/proxy/tasks", tasksProxy);
    expressApp.use("/api/proxy/desktop-audio/live", async (req, res) => {
      const controller = new AbortController();
      const abortStream = () => controller.abort();
      req.on("close", abortStream);
      res.on("close", abortStream);

      try {
        const upstream = await fetch(`${desktopOrigin}/computer-use/audio/live`, {
          signal: controller.signal,
          headers: {
            Accept: req.headers.accept || "*/*",
          },
        });

        res.status(upstream.status);
        upstream.headers.forEach((value, key) => {
          if (key.toLowerCase() !== "transfer-encoding") {
            res.setHeader(key, value);
          }
        });
        res.flushHeaders?.();

        if (!upstream.body) {
          const body = await upstream.text();
          res.end(body);
          return;
        }

        Readable.fromWeb(upstream.body as any).pipe(res);
      } catch (error: any) {
        if (!res.headersSent) {
          res.status(502).json({
            message: `Failed to proxy desktop audio: ${error.message}`,
          });
        } else {
          res.end();
        }
      }
    });
    expressApp.use("/api/proxy/desktop-audio/status", async (_req, res) => {
      try {
        const upstream = await fetch(`${desktopOrigin}/computer-use/audio/status`, {
          headers: {
            Accept: "application/json",
          },
        });

        res.status(upstream.status);
        upstream.headers.forEach((value, key) => {
          if (key.toLowerCase() !== "transfer-encoding") {
            res.setHeader(key, value);
          }
        });

        if (!upstream.body) {
          const body = await upstream.text();
          res.end(body);
          return;
        }

        Readable.fromWeb(upstream.body as any).pipe(res);
      } catch (error: any) {
        res.status(502).json({
          message: `Failed to proxy desktop audio status: ${error.message}`,
        });
      }
    });
    expressApp.use("/api/proxy/websockify", (req, res) => {
      console.log("Proxying websockify request");
      // Rewrite path
      req.url =
        desktopTargetUrl.pathname +
        (req.url?.replace(/^\/api\/proxy\/websockify/, "") || "");
      vncProxy.web(req, res, {
        target: desktopOrigin,
      });
    });

    // Handle all other requests with Next.js
    expressApp.all("*", (req, res) => handle(req, res));

    // Properly upgrade WebSocket connections
    server.on("upgrade", (request, socket, head) => {
      const { pathname } = new URL(
        request.url!,
        `http://${request.headers.host}`,
      );

      if (pathname.startsWith("/api/proxy/tasks")) {
        return tasksProxy.upgrade(request, socket as any, head);
      }

      if (pathname.startsWith("/api/proxy/websockify")) {
        request.url =
          desktopTargetUrl.pathname +
          (request.url?.replace(/^\/api\/proxy\/websockify/, "") || "");
        console.log("Proxying websockify upgrade request: ", request.url);
        return vncProxy.ws(request, socket as any, head, {
          target: desktopOrigin,
        });
      }

      nextUpgradeHandler(request, socket, head);
    });

    server.listen(port, hostname, () => {
      console.log(`> Ready on http://${hostname}:${port}`);
    });
  })
  .catch((err) => {
    console.error("Server failed to start:", err);
    process.exit(1);
  });
