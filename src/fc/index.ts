// Aliyun Function Compute (FC 3.0) HTTP handler entry point.
//
// FC's built-in Node.js HTTP trigger delivers an API-Gateway v1 style event
// (rawPath / headers / queryParameters / body / isBase64Encoded) and expects a
// { statusCode, headers, body, isBase64Encoded } response. This module adapts
// that protocol to the standard Fetch API so the existing Hono app can run
// unchanged on FC, backed by the sql.js persistence adapter.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../app";
import { setFallbackDatabaseAdapter } from "../context";
import type { Env } from "../types";
import {
  createSqlJsDatabaseAdapter,
  databaseHasTable,
  execScript,
} from "./sqljsAdapter";

const app = createApp();

const env: Env = {
  PASSWORD_PEPPER: process.env.PASSWORD_PEPPER ?? "",
  ADMIN_TOKEN: process.env.ADMIN_TOKEN ?? "",
  RUNTIME_TARGET: "node",
  DB_DRIVER: "sqlite",
  SQLITE_PATH: process.env.SQLITE_PATH ?? "/mnt/data/koreader-sync.db",
  DEBUG: process.env.DEBUG,
  SESSION_TTL_HOURS: process.env.SESSION_TTL_HOURS,
  SESSION_RENEW_WINDOW_HOURS: process.env.SESSION_RENEW_WINDOW_HOURS,
  PBKDF2_ITERATIONS: process.env.PBKDF2_ITERATIONS,
  ENABLE_USER_REGISTRATION: process.env.ENABLE_USER_REGISTRATION,
};

let bootstrap: Promise<void> | null = null;

function migrationFiles(): string[] {
  const dir = join(__dirname, "migrations");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

function ensureBootstrap(): Promise<void> {
  if (!bootstrap) {
    bootstrap = (async () => {
      if (!env.PASSWORD_PEPPER || !env.ADMIN_TOKEN) {
        throw new Error("PASSWORD_PEPPER and ADMIN_TOKEN environment variables are required");
      }
      const db = await createSqlJsDatabaseAdapter(env.SQLITE_PATH!);
      if (!(await databaseHasTable("users"))) {
        for (const file of migrationFiles()) {
          await execScript(readFileSync(join(__dirname, "migrations", file), "utf8"));
        }
      }
      setFallbackDatabaseAdapter(db);
    })().catch((error) => {
      // Allow the next invocation to retry if bootstrap failed.
      bootstrap = null;
      throw error;
    });
  }
  return bootstrap;
}

interface FcHttpEvent {
  rawPath?: string;
  headers?: Record<string, string | string[] | undefined>;
  queryParameters?: Record<string, string | string[] | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: {
    domainName?: string;
    http?: { method?: string; path?: string };
  };
}

function parseEvent(raw: unknown): FcHttpEvent {
  if (Buffer.isBuffer(raw)) return JSON.parse(raw.toString("utf8")) as FcHttpEvent;
  if (typeof raw === "string") return JSON.parse(raw) as FcHttpEvent;
  return raw as FcHttpEvent;
}

function buildQueryString(query: FcHttpEvent["queryParameters"]): string {
  if (!query) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, String(item));
    } else {
      search.append(key, String(value));
    }
  }
  return search.toString();
}

function toRequest(event: FcHttpEvent): Request {
  const method = (event.requestContext?.http?.method ?? "GET").toUpperCase();
  const host = event.headers?.Host ?? event.headers?.host ?? event.requestContext?.domainName ?? "function.local";
  const path = event.rawPath ?? event.requestContext?.http?.path ?? "/";
  const query = buildQueryString(event.queryParameters);
  const url = `https://${host}${path}${query ? `?${query}` : ""}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach((item) => headers.append(key, String(item)));
    else headers.set(key, String(value));
  }

  let body: Uint8Array | undefined;
  if (event.body && event.body.length > 0 && method !== "GET" && method !== "HEAD") {
    body = event.isBase64Encoded
      ? new Uint8Array(Buffer.from(event.body, "base64"))
      : new TextEncoder().encode(event.body);
  }

  return new Request(url, { method, headers, body });
}

async function toFcResponse(response: Response) {
  const bytes = Buffer.from(await response.arrayBuffer());
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  // Preserve individual cookies when the runtime exposes them.
  const cookies = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.();
  if (cookies && cookies.length > 0) {
    headers["set-cookie"] = cookies.join(", ");
  }

  // The Function Compute fcapp.run gateway injects `Content-Disposition:
  // attachment` unless the function sets it explicitly, which makes browsers
  // download HTML instead of rendering it. Force inline for normal responses
  // while keeping any attachment the app itself asked for.
  if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-disposition")) {
    headers["content-disposition"] = "inline";
  }

  return {
    statusCode: response.status,
    headers,
    body: bytes.toString("base64"),
    isBase64Encoded: true,
  };
}

export async function handler(rawEvent: unknown): Promise<unknown> {
  await ensureBootstrap();
  const event = parseEvent(rawEvent);
  const request = toRequest(event);
  const response = await app.fetch(request, env);
  return toFcResponse(response);
}
