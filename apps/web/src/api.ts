import type {
  AttachHostSessionRequest,
  AttachHostSessionResponse,
  BootstrapPayload,
  BudgetSummary,
  CreateCommandRequest,
  CreateCommandResponse,
  CreateLocalThreadRequest,
  CreateLocalThreadResponse,
  DetachHostSessionRequest,
  DetachHostSessionResponse,
  DogfoodSafetyPostureResponse,
  RefreshHostSessionsResponse,
  ResolveTurnInteractionRequest,
  ResolveTurnInteractionResponse,
  SetDogfoodSafetyPauseRequest,
  SetDogfoodSafetyPauseResponse,
  TaskArchiveResponse,
  ThreadEventsResponse
} from "@chaop/protocol";
import { fallbackBootstrap } from "./sample-data.js";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly payload?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function loadBootstrap(): Promise<BootstrapPayload> {
  try {
    const response = await fetch(apiUrl("/api/bootstrap"), {
      credentials: "include",
      headers: devHeaders()
    });
    if (!response.ok) {
      throw await responseError(response, "Bootstrap failed");
    }
    return (await response.json()) as BootstrapPayload;
  } catch (error) {
    if (devFallbackEnabled()) {
      return fallbackBootstrap();
    }
    throw error;
  }
}

export async function loadUsageSummary(): Promise<BudgetSummary> {
  try {
    const response = await fetch(apiUrl("/api/usage-summary"), {
      credentials: "include",
      headers: devHeaders()
    });
    if (!response.ok) {
      throw await responseError(response, "Usage summary failed");
    }
    return (await response.json()) as BudgetSummary;
  } catch (error) {
    if (devFallbackEnabled()) {
      return fallbackBootstrap().budget;
    }
    throw error;
  }
}

export async function bootstrapBudgetSamples(): Promise<BudgetSummary> {
  return postJson("/api/budget/bootstrap", {});
}

export async function loadSafetyPosture(): Promise<DogfoodSafetyPostureResponse> {
  try {
    const response = await fetch(apiUrl("/api/safety-posture"), {
      credentials: "include",
      headers: devHeaders()
    });
    if (!response.ok) {
      throw await responseError(response, "Safety posture failed");
    }
    return (await response.json()) as DogfoodSafetyPostureResponse;
  } catch (error) {
    if (devFallbackEnabled()) {
      return { safety: fallbackBootstrap().safety };
    }
    throw error;
  }
}

export async function pauseDogfoodSafety(
  request: SetDogfoodSafetyPauseRequest
): Promise<SetDogfoodSafetyPauseResponse> {
  return postJson("/api/safety/pause", request);
}

export async function resumeDogfoodSafety(): Promise<SetDogfoodSafetyPauseResponse> {
  return postJson("/api/safety/resume", {});
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
    throw await responseError(response, "Command creation failed");
  }

  return (await response.json()) as CreateCommandResponse;
}

export async function createLocalThread(request: CreateLocalThreadRequest): Promise<CreateLocalThreadResponse> {
  return postJson("/api/local-threads", request);
}

export async function archiveTask(taskId: string): Promise<TaskArchiveResponse> {
  return postJson(`/api/tasks/${encodeURIComponent(taskId)}/archive`, {});
}

export async function unarchiveTask(taskId: string): Promise<TaskArchiveResponse> {
  return postJson(`/api/tasks/${encodeURIComponent(taskId)}/unarchive`, {});
}

export async function attachHostSession(
  sessionId: string,
  request: AttachHostSessionRequest
): Promise<AttachHostSessionResponse> {
  return postJson(`/api/host-sessions/${encodeURIComponent(sessionId)}/attach`, request);
}

export async function detachHostSession(
  sessionId: string,
  request: DetachHostSessionRequest
): Promise<DetachHostSessionResponse> {
  return postJson(`/api/host-sessions/${encodeURIComponent(sessionId)}/detach`, request);
}

export async function refreshHostSessions(): Promise<RefreshHostSessionsResponse> {
  return postJson("/api/host-sessions/refresh", {});
}

export async function loadThreadEvents(threadId: string): Promise<ThreadEventsResponse> {
  try {
    const response = await fetch(apiUrl(`/api/threads/${encodeURIComponent(threadId)}/events`), {
      credentials: "include",
      headers: devHeaders()
    });

    if (!response.ok) {
      throw await responseError(response, "Thread events failed");
    }

    return (await response.json()) as ThreadEventsResponse;
  } catch (error) {
    if (devFallbackEnabled()) {
      return { events: [] };
    }
    throw error;
  }
}

export async function resolveTurnInteraction(
  eventId: string,
  request: ResolveTurnInteractionRequest
): Promise<ResolveTurnInteractionResponse> {
  return postJson(`/api/thread-events/${encodeURIComponent(eventId)}/interaction`, request);
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
    throw await responseError(response, "Request failed");
  }

  return (await response.json()) as T;
}

async function responseError(response: Response, fallback: string): Promise<ApiError> {
  const error = await responseErrorPayload(response);
  return new ApiError(response.status, `${fallback}: ${error.message ?? `HTTP ${response.status}`}`, error.payload);
}

async function responseErrorPayload(response: Response): Promise<{ message?: string | undefined; payload?: unknown }> {
  const contentType = response.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      const body = (await response.json()) as unknown;
      if (typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string") {
        return { message: (body as { error: string }).error, payload: body };
      }
      return { payload: body };
    }

    const text = await response.text();
    return { message: text.trim() || undefined };
  } catch {
    return {};
  }
}

function devHeaders(): HeadersInit {
  return devFallbackEnabled() ? { "x-chaop-dev-user": "operator@example.com" } : {};
}

function devFallbackEnabled(): boolean {
  return import.meta.env?.DEV === true;
}
