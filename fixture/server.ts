import express, { type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import crypto from "node:crypto";

// ---------- in-memory state ----------

type Item = { id: string; title: string };

type SessionStore = Map<string, { email: string }>;

const VALID_EMAIL = "test@example.com";
const VALID_PASSWORD = "password123";

// ---------- helpers ----------

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k) out[k] = decodeURIComponent(v.join("="));
  }
  return out;
}

function getSession(req: Request, sessions: SessionStore): { email: string } | null {
  const token = parseCookies(req.headers.cookie).session;
  if (!token) return null;
  return sessions.get(token) ?? null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${body}</body></html>`;
}

function isAuthed(req: Request, sessions: SessionStore): boolean {
  return getSession(req, sessions) !== null;
}

// ---------- app ----------

const upload = multer({ storage: multer.memoryStorage() });

export function createApp(): express.Express {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  // Per-app in-memory state: each createApp() call is isolated,
  // so parallel fixtures and tests never share items or sessions.
  const items: Item[] = [];
  const sessions: SessionStore = new Map();

  function requireAuth(req: Request, res: Response, next: NextFunction): void {
    if (!isAuthed(req, sessions)) {
      res.redirect(302, "/login");
      return;
    }
    next();
  }

  // Home (simple)
  app.get("/", (_req, res) => {
    res.type("html").send(page("Prowl Fixture", "<h1>Prowl Fixture App</h1><p><a href=\"/login\">Login</a></p>"));
  });

  // Login
  app.get("/login", (req, res) => {
    const error = req.query.error === "1";
    const body = `
      <h1>Login</h1>
      <form method="post" action="/login">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" required>
        <label for="password">Password</label>
        <input id="password" name="password" type="password" required>
        <button type="submit">Sign in</button>
      </form>
      ${error ? '<p role="alert">Invalid email or password</p>' : ""}
    `;
    res.type("html").send(page("Login", body));
  });

  app.post("/login", (req, res) => {
    const email = String(req.body?.email ?? "");
    const password = String(req.body?.password ?? "");
    if (email === VALID_EMAIL && password === VALID_PASSWORD) {
      const token = crypto.randomUUID();
      sessions.set(token, { email });
      res.setHeader(
        "Set-Cookie",
        `session=${token}; HttpOnly; Path=/; SameSite=Lax`,
      );
      res.redirect(302, "/items");
    } else {
      res.status(401).type("html").send(page("Login", `
        <h1>Login</h1>
        <form method="post" action="/login">
          <label for="email">Email</label>
          <input id="email" name="email" type="email" required>
          <label for="password">Password</label>
          <input id="password" name="password" type="password" required>
          <button type="submit">Sign in</button>
        </form>
        <p role="alert">Invalid email or password</p>
      `));
    }
  });

  // Items (logged-in only)
  app.get("/items", requireAuth, (_req, res) => {
    const listHtml = items
      .map(
        (it) => `
        <li>
          <form method="post" action="/items/${escapeHtml(it.id)}" style="display:inline">
            <label for="title-${escapeHtml(it.id)}">Title</label>
            <input id="title-${escapeHtml(it.id)}" name="title" value="${escapeHtml(it.title)}">
            <button type="submit">Save</button>
          </form>
          <form method="post" action="/items/${escapeHtml(it.id)}/delete" style="display:inline">
            <button type="submit">Delete</button>
          </form>
        </li>`,
      )
      .join("");

    const body = `
      <h1>Items</h1>
      <button id="new-item-btn" type="button">New item</button>
      <div id="new-item-form" hidden>
        <form method="post" action="/items">
          <label for="new-title">Title</label>
          <input id="new-title" name="title" required>
          <button type="submit">Save</button>
        </form>
      </div>
      <ul id="items-list">${listHtml}</ul>
      <script>
        document.getElementById('new-item-btn').addEventListener('click', function() {
          var f = document.getElementById('new-item-form');
          f.hidden = false;
        });
      </script>
    `;
    res.type("html").send(page("Items", body));
  });

  app.post("/items", requireAuth, (req, res) => {
    const title = String(req.body?.title ?? "").trim();
    if (title) items.push({ id: crypto.randomUUID(), title });
    res.redirect(302, "/items");
  });

  app.post("/items/:id", requireAuth, (req, res) => {
    const item = items.find((i) => i.id === req.params.id);
    if (item) item.title = String(req.body?.title ?? item.title).trim() || item.title;
    res.redirect(302, "/items");
  });

  app.post("/items/:id/delete", requireAuth, (req, res) => {
    const idx = items.findIndex((i) => i.id === req.params.id);
    if (idx !== -1) items.splice(idx, 1);
    res.redirect(302, "/items");
  });

  // Frame
  app.get("/frame", (_req, res) => {
    const body = `<h1>Frame</h1><iframe src="/frame-inner" title="Inner frame"></iframe>`;
    res.type("html").send(page("Frame", body));
  });

  app.get("/frame-inner", (_req, res) => {
    const body = `<h1>Frame inner</h1><button type="button">Inside frame</button>`;
    res.type("html").send(page("Frame inner", body));
  });

  // Shadow DOM
  app.get("/shadow", (_req, res) => {
    const body = `
      <h1>Shadow</h1>
      <my-widget></my-widget>
      <script>
        class MyWidget extends HTMLElement {
          constructor() {
            super();
            const root = this.attachShadow({ mode: 'open' });
            const btn = document.createElement('button');
            btn.textContent = 'Shadow button';
            root.appendChild(btn);
          }
        }
        customElements.define('my-widget', MyWidget);
      </script>
    `;
    res.type("html").send(page("Shadow", body));
  });

  // Dialogs
  app.get("/dialogs", (_req, res) => {
    const body = `
      <h1>Dialogs</h1>
      <button type="button" onclick="showAlert()">Alert</button>
      <button type="button" onclick="showConfirm()">Confirm</button>
      <button type="button" onclick="showPrompt()">Prompt</button>
      <p id="result"></p>
      <script>
        function showAlert() { alert('hello'); document.getElementById('result').textContent = 'alert shown'; }
        function showConfirm() {
          var r = confirm('are you sure?');
          document.getElementById('result').textContent = 'confirm: ' + r;
        }
        function showPrompt() {
          var r = prompt('enter a value');
          document.getElementById('result').textContent = 'prompt: ' + (r === null ? 'null' : r);
        }
      </script>
    `;
    res.type("html").send(page("Dialogs", body));
  });

  // Lazy
  app.get("/lazy", (_req, res) => {
    const body = `
      <h1>Lazy</h1>
      <div id="container"></div>
      <script>
        setTimeout(function() {
          var p = document.createElement('p');
          p.textContent = 'Lazy content loaded';
          document.getElementById('container').appendChild(p);
        }, 1500);
      </script>
    `;
    res.type("html").send(page("Lazy", body));
  });

  // JS-rendered page (price is added by script after load; M0 Task 2)
  app.get("/js-page", (_req, res) => {
    const body = `
      <h1>JS page</h1>
      <div id="app">Loading...</div>
      <script>
        setTimeout(function() {
          document.getElementById('app').innerHTML =
            '<p>Price: 42 dollars</p>';
        }, 500);
      </script>
    `;
    res.type("html").send(page("JS page", body));
  });

  // Tabs test (link opens the item list in a new tab; M0 Task 3)
  app.get("/tabs", (_req, res) => {
    const body = `<h1>Tabs test</h1><a href="/items" target="_blank" rel="noopener">Open items in new tab</a>`;
    res.type("html").send(page("Tabs test", body));
  });

  // Upload
  app.get("/upload", (_req, res) => {
    const body = `
      <h1>Upload</h1>
      <form method="post" action="/upload" enctype="multipart/form-data">
        <label for="file">File</label>
        <input id="file" name="file" type="file">
        <button type="submit">Upload</button>
      </form>
    `;
    res.type("html").send(page("Upload", body));
  });

  app.post("/upload", upload.single("file"), (req, res) => {
    const name = req.file?.originalname ?? "none";
    res.type("html").send(page("Upload", `<h1>Upload</h1><p>Uploaded: ${escapeHtml(name)}</p>`));
  });

  // Download
  app.get("/download", (_req, res) => {
    res.setHeader("Content-Disposition", 'attachment; filename="sample.txt"');
    res.type("text/plain").send("This is a small text file.\n");
  });

  // Offsite
  app.get("/offsite", (_req, res) => {
    const body = `<h1>Offsite</h1><a href="https://example.org">Go offsite</a>`;
    res.type("html").send(page("Offsite", body));
  });

  // Reset
  app.get("/reset", (_req, res) => {
    items.length = 0;
    sessions.clear();
    res.json({ ok: true });
  });

  return app;
}

export interface FixtureHandle {
  close: () => Promise<void>;
  /** Actual bound port (useful when started with port 0). */
  port: number;
}

export function startFixture(port = 4173): Promise<FixtureHandle> {
  const app = createApp();
  const server = app.listen(port);
  const ready = new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  return ready.then(() => {
    const addr = server.address();
    const boundPort =
      typeof addr === "object" && addr !== null && "port" in addr && typeof addr.port === "number"
        ? addr.port
        : port;
    return {
      port: boundPort,
      close: () =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((err) => (err ? reject(err) : resolve()));
        }),
    };
  });
}

// Allow running directly: `pnpm fixture`
const isMain = /server\.[tj]s$/.test(process.argv[1] ?? "");
if (isMain) {
  const port = Number(process.env.FIXTURE_PORT ?? 4173);
  startFixture(port).then(
    () => console.log(`Fixture app listening on http://localhost:${port}`),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
