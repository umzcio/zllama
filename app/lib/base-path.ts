const raw = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const withLeadingSlash = raw && !raw.startsWith("/") ? `/${raw}` : raw;
export const basePath = withLeadingSlash.endsWith("/")
  ? withLeadingSlash.slice(0, -1)
  : withLeadingSlash;

export function withBasePath(path: string): string {
  if (!basePath) return path;
  if (!path.startsWith("/")) return path;
  if (/^https?:\/\//i.test(path)) return path;
  if (path === basePath) return path;
  if (path.startsWith(`${basePath}/`)) return path;
  return `${basePath}${path}`;
}

let installed = false;

export function installBasePathFetch() {
  if (installed) return;
  if (!basePath) return;
  if (typeof window === "undefined") return;
  installed = true;

  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (typeof input === "string") {
      return originalFetch(rewrite(input), init);
    }
    if (input instanceof URL) {
      const next = new URL(input.toString());
      if (next.origin === window.location.origin) {
        next.pathname = rewritePath(next.pathname);
      }
      return originalFetch(next, init);
    }
    if (input instanceof Request) {
      try {
        const url = new URL(input.url);
        if (url.origin === window.location.origin) {
          url.pathname = rewritePath(url.pathname);
          return originalFetch(new Request(url, input), init);
        }
      } catch {
        // fall through to original
      }
    }
    return originalFetch(input as RequestInfo, init);
  };
}

function rewrite(input: string): string {
  if (/^https?:\/\//i.test(input)) {
    try {
      const url = new URL(input);
      if (url.origin === window.location.origin) {
        url.pathname = rewritePath(url.pathname);
        return url.toString();
      }
    } catch {
      // ignore
    }
    return input;
  }
  if (input.startsWith("/")) return rewritePath(input);
  return input;
}

function rewritePath(pathname: string): string {
  if (!pathname.startsWith("/api/")) return pathname;
  if (pathname === basePath) return pathname;
  if (pathname.startsWith(`${basePath}/`)) return pathname;
  return `${basePath}${pathname}`;
}
