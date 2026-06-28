import type {
  CreateRepoInput,
  DocumentSummary,
  DocumentVersion,
  PublishResult,
  Repository,
  UpdateRepoInput,
} from "@maradocs/shared";
import type { CliConfig } from "./config.js";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export class MaraClient {
  constructor(private config: CliConfig) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (this.config.apiKey) h.authorization = `Bearer ${this.config.apiKey}`;
    return h;
  }

  private async request<T>(
    method: string,
    pathname: string,
    options: { json?: unknown; body?: FormData | string; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const headers = this.headers(options.headers);
    let body: FormData | string | undefined = options.body;
    if (options.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.json);
    }
    let res: Response;
    try {
      res = await fetch(`${this.config.server}${pathname}`, { method, headers, body });
    } catch (err) {
      throw new ApiError(
        0,
        "network_error",
        `Could not reach ${this.config.server} (${(err as Error).message})`,
      );
    }
    const text = await res.text();
    const data = text ? safeJson(text) : null;
    if (!res.ok) {
      const message =
        (data as { message?: string } | null)?.message ?? `${res.status} ${res.statusText}`;
      const code = (data as { error?: string } | null)?.error ?? "error";
      throw new ApiError(res.status, code, message);
    }
    return data as T;
  }

  health(): Promise<{ status: string }> {
    return this.request("GET", "/health");
  }

  listRepos(): Promise<{ repos: Repository[] }> {
    return this.request("GET", "/api/v1/repos");
  }

  createRepo(input: CreateRepoInput): Promise<{ repo: Repository }> {
    return this.request("POST", "/api/v1/repos", { json: input });
  }

  updateRepo(slug: string, input: UpdateRepoInput): Promise<{ repo: Repository }> {
    return this.request("PATCH", `/api/v1/repos/${slug}`, { json: input });
  }

  listDocs(repo: string): Promise<{ docs: DocumentSummary[] }> {
    return this.request("GET", `/api/v1/repos/${repo}/docs`);
  }

  listVersions(repo: string, doc: string): Promise<{ versions: DocumentVersion[] }> {
    return this.request("GET", `/api/v1/repos/${repo}/docs/${doc}/versions`);
  }

  rollback(repo: string, doc: string, version: number): Promise<{ doc: DocumentSummary }> {
    return this.request("POST", `/api/v1/repos/${repo}/docs/${doc}/rollback`, {
      json: { version },
    });
  }

  deleteDoc(repo: string, doc: string): Promise<{ deleted: boolean }> {
    return this.request("DELETE", `/api/v1/repos/${repo}/docs/${doc}`);
  }

  async publish(
    repo: string,
    fields: {
      doc: string;
      title?: string;
      access?: string;
      password?: string;
      entrypoint?: string;
    },
    zip: Buffer,
    replace = false,
  ): Promise<PublishResult> {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) form.append(key, value);
    }
    form.append(
      "file",
      new Blob([new Uint8Array(zip)], { type: "application/zip" }),
      `${fields.doc}.zip`,
    );
    const pathname = replace
      ? `/api/v1/repos/${repo}/docs/${fields.doc}`
      : `/api/v1/repos/${repo}/docs`;
    return this.request<PublishResult>(replace ? "PUT" : "POST", pathname, {
      body: form,
    });
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}
