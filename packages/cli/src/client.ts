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
    const h: Record<string, string> = {};
    if (this.config.apiKey) h.authorization = `Bearer ${this.config.apiKey}`;
    // Explicit per-request headers win (e.g. bootstrap's session token).
    return { ...h, ...extra };
  }

  /** Abort signal so requests fail fast instead of hanging on a dead server. */
  private timeoutSignal(): AbortSignal {
    const seconds = Number(process.env.MARADOCS_TIMEOUT ?? 120);
    return AbortSignal.timeout((Number.isFinite(seconds) && seconds > 0 ? seconds : 120) * 1000);
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
      res = await fetch(`${this.config.server}${pathname}`, {
        method,
        headers,
        body,
        signal: this.timeoutSignal(),
      });
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

  /** Exchange the dashboard admin password for a short-lived session token. */
  adminLogin(password: string): Promise<{ token: string }> {
    return this.request("POST", "/api/v1/auth/login", { json: { password } });
  }

  /** Mint a new API key using an admin session token. The key is shown once. */
  createApiKey(
    sessionToken: string,
    input: { name: string; scopes?: string[] },
  ): Promise<{ key: string; id: string; name: string; prefix: string; scopes: string[] }> {
    return this.request("POST", "/api/v1/auth/keys", {
      json: input,
      headers: { authorization: `Bearer ${sessionToken}` },
    });
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

  /** Download a version's files as a zip bundle (latest when no version given). */
  async downloadBundle(
    repo: string,
    doc: string,
    version?: number,
  ): Promise<{
    buffer: Buffer;
    versionNumber: number | null;
    checksum: string | null;
    entrypoint: string | null;
  }> {
    const qs = version !== undefined ? `?version=${version}` : "";
    const pathname = `/api/v1/repos/${repo}/docs/${doc}/bundle${qs}`;
    let res: Response;
    try {
      res = await fetch(`${this.config.server}${pathname}`, {
        headers: this.headers(),
        signal: this.timeoutSignal(),
      });
    } catch (err) {
      throw new ApiError(
        0,
        "network_error",
        `Could not reach ${this.config.server} (${(err as Error).message})`,
      );
    }
    if (!res.ok) {
      const data = safeJson(await res.text()) as { error?: string; message?: string } | null;
      throw new ApiError(
        res.status,
        data?.error ?? "error",
        data?.message ?? `${res.status} ${res.statusText}`,
      );
    }
    const versionHeader = res.headers.get("x-maradocs-version-number");
    return {
      buffer: Buffer.from(await res.arrayBuffer()),
      versionNumber: versionHeader ? Number(versionHeader) : null,
      checksum: res.headers.get("x-maradocs-checksum"),
      entrypoint: res.headers.get("x-maradocs-entrypoint"),
    };
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
