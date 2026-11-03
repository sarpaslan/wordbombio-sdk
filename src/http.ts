import { WordBombError } from "./errors.js";
import type { Session } from "./session.js";
import { httpError, readBody } from "./util.js";

export type Service = "game" | "social" | "player";

export interface RequestOptions {
  method?: string;
  body?: unknown;
}

export class Http {
  constructor(private readonly session: Session) {}

  async request<T>(service: Service, route: string, init: RequestOptions = {}): Promise<T> {
    let res = await this.send(service, route, init);
    if (res.status === 401) {
      await this.session.refresh();
      res = await this.send(service, route, init);
    }
    const { data, text } = await readBody(res);
    if (!res.ok) throw httpError(route, res, data, text);
    return data as T;
  }

  get<T>(service: Service, route: string): Promise<T> {
    return this.request<T>(service, route);
  }

  post<T>(service: Service, route: string, body: unknown = {}): Promise<T> {
    return this.request<T>(service, route, { method: "POST", body });
  }

  put<T>(service: Service, route: string, body: unknown = {}): Promise<T> {
    return this.request<T>(service, route, { method: "PUT", body });
  }

  delete<T>(service: Service, route: string, body?: unknown): Promise<T> {
    return this.request<T>(service, route, { method: "DELETE", body });
  }

  private async send(service: Service, route: string, init: RequestOptions): Promise<Response> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.session.token}` };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    const url = `${this.session.target[service]}${route}`;
    try {
      return await fetch(url, {
        method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
    } catch (e) {
      throw new WordBombError("HTTP", `could not reach ${url}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
