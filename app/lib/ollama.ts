export interface OllamaModel {
  name: string;
  model: string;
  modified_at: string;
  size: number;
  digest: string;
  details: {
    parent_model: string;
    format: string;
    family: string;
    families: string[];
    parameter_size: string;
    quantization_level: string;
  };
}

export interface OllamaRunningModel {
  name: string;
  model: string;
  size: number;
  digest: string;
  details: {
    parent_model: string;
    format: string;
    family: string;
    families: string[];
    parameter_size: string;
    quantization_level: string;
  };
  expires_at: string;
  size_vram: number;
}

export interface OllamaVersion {
  version: string;
}

export interface OllamaPullProgress {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
}

export interface OllamaChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  images?: string[];
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  stream?: boolean;
  options?: Record<string, unknown>;
  keep_alive?: string;
}

export interface OllamaChatResponse {
  model: string;
  created_at: string;
  message: OllamaChatMessage;
  done: boolean;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
  eval_duration?: number;
}

export interface OllamaShowResponse {
  modelfile: string;
  parameters: string;
  template: string;
  details: {
    parent_model: string;
    format: string;
    family: string;
    families: string[];
    parameter_size: string;
    quantization_level: string;
  };
  model_info: Record<string, unknown>;
}

export async function ollamaFetch<T>(
  baseUrl: string,
  path: string,
  options?: RequestInit,
  timeoutMs?: number
): Promise<T> {
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;
  const res = await fetch(url, {
    ...options,
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
    // No default timeout: callers like deleteModel/copyModel can legitimately
    // run long. Only pass a signal when a caller explicitly opts in.
    ...(timeoutMs !== undefined ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  });

  if (!res.ok) {
    throw new Error(`Ollama API error: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

export async function getVersion(
  baseUrl: string,
  timeoutMs?: number
): Promise<OllamaVersion> {
  return ollamaFetch<OllamaVersion>(baseUrl, "/api/version", undefined, timeoutMs);
}

export async function listModels(
  baseUrl: string,
  timeoutMs?: number
): Promise<{ models: OllamaModel[] }> {
  return ollamaFetch<{ models: OllamaModel[] }>(baseUrl, "/api/tags", undefined, timeoutMs);
}

export async function listRunningModels(
  baseUrl: string
): Promise<{ models: OllamaRunningModel[] }> {
  return ollamaFetch<{ models: OllamaRunningModel[] }>(baseUrl, "/api/ps");
}

export async function showModel(
  baseUrl: string,
  name: string
): Promise<OllamaShowResponse> {
  return ollamaFetch<OllamaShowResponse>(baseUrl, "/api/show", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export async function deleteModel(
  baseUrl: string,
  name: string
): Promise<void> {
  await ollamaFetch(baseUrl, "/api/delete", {
    method: "DELETE",
    body: JSON.stringify({ name }),
  });
}

export async function copyModel(
  baseUrl: string,
  source: string,
  destination: string
): Promise<void> {
  await ollamaFetch(baseUrl, "/api/copy", {
    method: "POST",
    body: JSON.stringify({ source, destination }),
  });
}
