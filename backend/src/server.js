import "dotenv/config";
import { bootstrap } from "./bootstrap.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import http from "http";
import cors from "cors";
import apiRoutes from "./routes/api.js";
import settingsRoutes from "./routes/settings.js";
import chatRoutes from "./routes/chat.js";
import authRoutes from "./routes/auth.js";
import userRoutes from "./routes/users.js";
import resourceRoutes from "./routes/resources.js";
import auditRoutes from "./routes/audit.js";
import mappingRoutes from "./routes/mappings.js";
import k3sRoutes from "./routes/k3s.js";
import dockerRoutes from "./routes/docker.js";
import infraStatusRoutes from "./routes/infraStatus.js";
import usageRoutes from "./routes/usage.js";
import notificationRoutes from "./routes/notifications.js";
import adminRoutes from "./routes/admin.js";
import integrationRoutes from "./routes/integrations.js";
import { attachTerminalWs } from "./routes/terminal.js";
import {
  attachDockerExecWs,
  attachDockerLogsWs,
  attachK8sExecWs,
  attachK8sLogsWs,
} from "./routes/containerWs.js";
import { startExpiryEnforcer } from "./services/expiryEnforcer.js";
import { startArchiveEnforcer } from "./services/archiveEnforcer.js";
import { PRODUCT_NAME } from "./constants/brand.js";

await bootstrap();

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api", authRoutes);
app.use("/api", apiRoutes);
app.use("/api", chatRoutes);
app.use("/api", userRoutes);
app.use("/api", resourceRoutes);
app.use("/api", auditRoutes);
// App-level reachability probes — any signed-in user (must stay ahead of
// admin-only routers historically mounted with blanket requireAdmin).
app.use("/api", infraStatusRoutes);
app.use("/api", mappingRoutes);
app.use("/api", settingsRoutes);
app.use("/api", k3sRoutes);
app.use("/api", dockerRoutes);
app.use("/api", usageRoutes);
app.use("/api", notificationRoutes);
app.use("/api", adminRoutes);
app.use("/api/integrations", integrationRoutes);

app.get("/health", (req, res) => res.json({ ok: true, product: PRODUCT_NAME }));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = process.env.FRONTEND_DIST || path.resolve(__dirname, "..", "..", "frontend", "dist");
const serveFrontend = process.env.NODE_ENV === "production" || process.env.SERVE_FRONTEND === "true";
if (serveFrontend && fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api") || req.path.startsWith("/ws") || req.path === "/health") return next();
    res.sendFile(path.join(distDir, "index.html"));
  });
  console.log(`Serving frontend from ${distDir}`);
}

const server = http.createServer(app);
attachTerminalWs(server);
attachDockerExecWs(server);
attachDockerLogsWs(server);
attachK8sExecWs(server);
attachK8sLogsWs(server);

const PORT = process.env.PORT || 4100;
server.listen(PORT, () => {
  console.log(`${PRODUCT_NAME} backend listening on :${PORT}`);
  startExpiryEnforcer();
  startArchiveEnforcer();
});
