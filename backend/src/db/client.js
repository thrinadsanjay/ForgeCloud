import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

let connected = false;

export async function connectDb() {
  if (connected) return;
  await prisma.$connect();
  connected = true;
}

export function fireAndForget(promise, label) {
  Promise.resolve(promise).catch((err) => {
    console.error(`[db] ${label} persist failed:`, err.message);
  });
}
