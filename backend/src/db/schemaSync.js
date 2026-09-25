import { execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, "..", "..");

export function syncSchema() {
  if (process.env.SKIP_DB_PUSH === "true") return;
  // ChatSession replaced the old flat ChatMessage table; Prisma warns about
  // data loss on that drop. Accept it so bootstrap can complete in Docker.
  const acceptLoss = process.env.PRISMA_ACCEPT_DATA_LOSS !== "false";
  const args = ["npx", "prisma", "db", "push", "--skip-generate"];
  if (acceptLoss) args.push("--accept-data-loss");
  try {
    execSync(args.join(" "), {
      cwd: backendRoot,
      stdio: "pipe",
      env: process.env,
    });
  } catch (err) {
    const msg = err.stderr?.toString() || err.message;
    throw new Error(`Database schema sync failed: ${msg}`);
  }
}
