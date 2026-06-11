import type {
  AttachHostSessionRequest,
  AttachHostSessionResponse,
  BootstrapPayload,
  CreateCommandRequest,
  CreateCommandResponse,
  TaskSummary
} from "@chaop/protocol";
import { fallbackBootstrap } from "./sample-data.js";

export async function loadBootstrap(): Promise<BootstrapPayload> {
  try {
    const response = await fetch(apiUrl("/api/bootstrap"), {
      credentials: "include",
      headers: devHeaders()
    });
    if (!response.ok) {
      throw new Error(`Bootstrap failed with ${response.status}`);
    }
    return (await response.json()) as BootstrapPayload;
  } catch (error) {
    if (import.meta.env.DEV) {
      return fallbackBootstrap();
    }
    throw error;
  }
}

export async function createCommand(request: CreateCommandRequest): Promise<CreateCommandResponse> {
  const response = await fetch(apiUrl("/api/commands"), {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "text/plain; charset=utf-8",
      ...devHeaders()
    },
    body: JSON.stringify(request)
  });

  if (!response.ok) {
    throw new Error(`Command creation failed with ${response.status}`);
  }

  return (await response.json()) as CreateCommandResponse;
}

export async function archiveTask(taskId: string): Promise<{ task: TaskSummary }> {
  return postJson(`/api/tasks/${encodeURIComponent(taskId)}/archive`, {});
}

export async function unarchiveTask(taskId: string): Promise<{ task: TaskSummary }> {
  return postJson(`/api/tasks/${encodeURIComponent(taskId)}/unarchive`, {});
}

export async function attachHostSession(
  sessionId: string,
  request: AttachHostSessionRequest
): Promise<AttachHostSessionResponse> {
  return postJson(`/api/host-sessions/${encodeURIComponent(sessionId)}/attach`, request);
}

export function browserSocketUrl(): string {
  const baseUrl = import.meta.env.VITE_CHAOP_API_BASE_URL?.replace(/\/+$/, "");
  if (baseUrl) {
    const url = new URL("/ws/browser", baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/browser`;
}

function apiUrl(path: string): string {
  const baseUrl = import.meta.env.VITE_CHAOP_API_BASE_URL?.replace(/\/+$/, "") ?? "";
  return `${baseUrl}${path}`;
}

async function postJson<T>(path: string, request: unknown): Promise<T> {
  const response = await fetch(apiUrl(path), {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "text/plain; charset=utf-8",
      ...devHeaders()
    },
    body: JSON.stringify(request)
  });

  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }

  return (await response.json()) as T;
}

function devHeaders(): HeadersInit {
  return import.meta.env.DEV ? { "x-chaop-dev-user": "operator@example.com" } : {};
}
