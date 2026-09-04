export type ApiResponse<T> = {
  success: boolean;
  data: T | null;
  error: string | null;
};

export type User = {
  id: string;
  email: string;
  username: string;
};

export type Project = {
  id: string;
  title: string;
  initialPrompt: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
};

export type ConversationMessage = {
  id: string;
  projectId: string;
  type: string;
  from: "USER" | "ASSISTANT" | string;
  contents: string;
  hidden: boolean;
  toolCall: string | null;
  createdAt: string;
};

export type ProjectDetail = Project & {
  conversationHistory: ConversationMessage[];
};

const TOKEN_KEY = "lovable_token";
const USER_KEY = "lovable_user";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getStoredUser(): User | null {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as User;
  } catch {
    return null;
  }
}

export function setSession(token: string, user: User) {
  localStorage.setItem(TOKEN_KEY, token);
  const safe = { id: user.id, email: user.email, username: user.username };
  localStorage.setItem(USER_KEY, JSON.stringify(safe));
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<ApiResponse<T>> {
  const headers = new Headers(options.headers);
  if (!headers.has("Content-Type") && options.body) {
    headers.set("Content-Type", "application/json");
  }
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(path, { ...options, headers });
  let json: ApiResponse<T>;
  try {
    json = (await res.json()) as ApiResponse<T>;
  } catch {
    throw new Error(`Request failed (${res.status})`);
  }
  if (!res.ok || !json.success) {
    throw new Error(json.error || `Request failed (${res.status})`);
  }
  return json;
}

export const api = {
  signup(body: { username: string; email: string; password: string }) {
    return request<User>("/api/v1/auth/signup", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  login(body: { email: string; password: string }) {
    return request<{ token: string; user: User }>("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  createProject(prompt: string) {
    return request<{ projectId: string }>("/api/v1/project", {
      method: "POST",
      body: JSON.stringify({ prompt }),
    });
  },

  listProjects() {
    return request<Project[]>("/api/v1/projects");
  },

  getProject(projectId: string) {
    return request<ProjectDetail>(`/api/v1/project/${projectId}`);
  },

  getSseTicket(projectId: string) {
    return request<{ ticket: string; expiresInMs: number }>(
      `/api/v1/project/${projectId}/events/ticket`,
      { method: "POST" },
    );
  },

  sendPrompt(projectId: string, prompt: string) {
    return request<{ sseUrl: string }>(
      `/api/v1/project/conversation/${projectId}`,
      {
        method: "POST",
        body: JSON.stringify({ prompt }),
      },
    );
  },

  runProject(projectId: string) {
    return request<{ url: string | null }>(`/api/v1/project/${projectId}/run`, {
      method: "POST",
    });
  },

  buildProject(projectId: string) {
    return request<null>(`/api/v1/project/${projectId}/build`, {
      method: "POST",
    });
  },
};
