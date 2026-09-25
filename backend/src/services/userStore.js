import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import { prisma, fireAndForget } from "../db/client.js";

const DEFAULT_PREFERENCES = { theme: "light", showBackground: true };

let users = [];

function withDefaults(user) {
  return {
    ...user,
    preferences: {
      ...DEFAULT_PREFERENCES,
      ...(user.preferences || {}),
    },
  };
}

function sanitizeUser(user) {
  const normalized = withDefaults(user);
  const { passwordHash, ...safe } = normalized;
  return safe;
}

function rowToUser(row) {
  return withDefaults({
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    email: row.email,
    role: row.role,
    source: row.source,
    passwordHash: row.passwordHash,
    preferences: row.preferences || {},
    createdAt: row.createdAt.toISOString(),
  });
}

export async function hydrateUsers() {
  const rows = await prisma.user.findMany();
  users = rows.map(rowToUser);
}

export async function ensureAdminSeed() {
  if (users.length > 0) return;
  const adminPass = process.env.FORGE_ADMIN_PASSWORD || process.env.SSP_ADMIN_PASSWORD || "admin123";
  const user = {
    id: nanoid(8),
    username: "admin",
    displayName: "Administrator",
    email: "admin@ssp.local",
    role: "admin",
    source: "local",
    passwordHash: bcrypt.hashSync(adminPass, 10),
    preferences: { ...DEFAULT_PREFERENCES },
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  await prisma.user.create({
    data: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      role: user.role,
      source: user.source,
      passwordHash: user.passwordHash,
      preferences: user.preferences,
      createdAt: new Date(user.createdAt),
    },
  });
}

function persistUser(user) {
  fireAndForget(
    prisma.user.upsert({
      where: { id: user.id },
      create: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        email: user.email,
        role: user.role,
        source: user.source,
        passwordHash: user.passwordHash,
        preferences: user.preferences || {},
        createdAt: new Date(user.createdAt),
      },
      update: {
        displayName: user.displayName,
        email: user.email,
        role: user.role,
        source: user.source,
        passwordHash: user.passwordHash,
        preferences: user.preferences || {},
      },
    }),
    "user"
  );
}

function deleteUserRow(id) {
  fireAndForget(prisma.user.delete({ where: { id } }), "user-delete");
}

export function listUsers() {
  return users.map(sanitizeUser);
}

export function findByUsername(username) {
  return users.find((u) => u.username.toLowerCase() === username.toLowerCase());
}

export function findById(id) {
  return users.find((u) => u.id === id);
}

export function verifyPassword(user, password) {
  if (!user.passwordHash) return false;
  return bcrypt.compareSync(password, user.passwordHash);
}

export function createUser({ username, password, displayName, email, role = "user", source = "local" }) {
  if (users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
    throw new Error(`User "${username}" already exists`);
  }
  const user = {
    id: nanoid(8),
    username,
    displayName: displayName || username,
    email: email || "",
    role,
    source,
    passwordHash: password ? bcrypt.hashSync(password, 10) : null,
    preferences: { ...DEFAULT_PREFERENCES },
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  persistUser(user);
  return sanitizeUser(user);
}

export function upsertExternalUser({ username, displayName, email, role = "user", source = "oidc" }) {
  let user = users.find((u) => u.username.toLowerCase() === username.toLowerCase());
  if (user) {
    user.displayName = displayName || user.displayName;
    user.email = email || user.email;
    user.source = source;
    persistUser(user);
  } else {
    user = {
      id: nanoid(8),
      username,
      displayName: displayName || username,
      email: email || "",
      role,
      source,
      passwordHash: null,
      preferences: { ...DEFAULT_PREFERENCES },
      createdAt: new Date().toISOString(),
    };
    users.push(user);
    persistUser(user);
  }
  return sanitizeUser(user);
}

export function updateUserRole(id, role) {
  const user = users.find((u) => u.id === id);
  if (!user) throw new Error("User not found");
  user.role = role;
  persistUser(user);
  return sanitizeUser(user);
}

export function updateUserPreferences(id, preferences = {}) {
  const user = users.find((u) => u.id === id);
  if (!user) throw new Error("User not found");
  user.preferences = {
    ...DEFAULT_PREFERENCES,
    ...(user.preferences || {}),
    ...(preferences || {}),
  };
  persistUser(user);
  return sanitizeUser(user);
}

export function deleteUser(id) {
  const before = users.length;
  users = users.filter((u) => u.id !== id);
  if (users.length === before) throw new Error("User not found");
  deleteUserRow(id);
}
