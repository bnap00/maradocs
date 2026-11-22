import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { buildApp } from "../src/app.js";
import type { AppContext } from "../src/context.js";

// app.ts reads these from process.env (not the env given to loadConfig). Without
// them each app starts a pino-pretty worker thread, which can keep the test
// process alive after all tests finish.
process.env.NO_PRETTY_LOG = "1";
process.env.LOG_LEVEL ??= "warn";

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  dataDir: string;
  close: () => Promise<void>;
}

export async function makeApp(env: Record<string, string> = {}): Promise<TestApp> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "maradocs-test-"));
  const config = loadConfig({
    NODE_ENV: "development",
    DATA_DIR: dataDir,
    PORT: "0",
    BCRYPT_ROUNDS: "4",
    NO_PRETTY_LOG: "1",
    ...env,
  } as NodeJS.ProcessEnv);
  const built = await buildApp(config);
  await built.app.ready();
  return {
    app: built.app,
    ctx: built.ctx,
    dataDir,
    close: async () => {
      await built.app.close();
      built.ctx.store.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** A fresh client IP so per-IP rate limits don't interfere between test steps. */
export function freshIp(): string {
  const b = crypto.randomBytes(3);
  return `10.${b[0]}.${b[1]}.${b[2]}`;
}

export const PASSWORD = "correct-horse-battery";

export interface Account {
  id: string;
  email: string;
  token: string;
  /** `Authorization: Bearer <session>` headers. */
  auth: { authorization: string };
}

export async function register(
  app: FastifyInstance,
  email: string,
  password = PASSWORD,
  extra: Record<string, unknown> = {},
): Promise<Account> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    remoteAddress: freshIp(),
    payload: { email, password, ...extra },
  });
  if (res.statusCode !== 201) {
    throw new Error(`register ${email} failed: ${res.statusCode} ${res.body}`);
  }
  const body = res.json<{ user: { id: string; email: string }; token: string }>();
  return {
    id: body.user.id,
    email: body.user.email,
    token: body.token,
    auth: { authorization: `Bearer ${body.token}` },
  };
}

export async function login(
  app: FastifyInstance,
  email: string,
  password = PASSWORD,
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    remoteAddress: freshIp(),
    payload: { email, password },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  return res.json<{ token: string }>().token;
}

export async function createKey(
  app: FastifyInstance,
  account: Account,
  scopes: string[] = ["publish"],
  name = "test-key",
): Promise<{ key: string; id: string; auth: { authorization: string } }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/keys",
    headers: account.auth,
    payload: { name, scopes },
  });
  if (res.statusCode !== 201) throw new Error(`createKey failed: ${res.statusCode} ${res.body}`);
  const { key, id } = res.json<{ key: string; id: string }>();
  return { key, id, auth: { authorization: `Bearer ${key}` } };
}

/** Extract `name=value` of a Set-Cookie header for the given cookie name. */
export function cookieFrom(setCookie: string | string[] | undefined, name: string): string | null {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const found = list.find((c) => c.startsWith(`${name}=`));
  return found ? found.split(";")[0]! : null;
}

export function sha256hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Build a multipart/form-data body (light-my-request can't encode web FormData). */
export function multipart(fields: Record<string, string>, file: Buffer) {
  const boundary = `----maradocstest${Math.random().toString(16).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="bundle.zip"\r\nContent-Type: application/zip\r\n\r\n`,
    ),
  );
  parts.push(file);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return {
    body: Buffer.concat(parts),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}
