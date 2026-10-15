import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFixture, type FixtureHandle } from "../fixture/server.js";

describe("fixture app smoke", () => {
  let handle: FixtureHandle | null = null;
  let BASE = "";

  // Fresh OS-assigned port per test: full state isolation and no
  // keep-alive pool collisions between server generations.
  beforeEach(async () => {
    handle = await startFixture(0);
    BASE = `http://localhost:${handle.port}`;
  });

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = null;
    }
  });

  it("starts and serves each route", async () => {
    const routes = ["/", "/login", "/frame", "/frame-inner", "/shadow", "/dialogs", "/lazy", "/js-page", "/tabs", "/upload", "/download", "/offsite", "/reset"];
    for (const route of routes) {
      const res = await fetch(`${BASE}${route}`);
      expect(res.status, route).toBe(200);
    }

    const loggedOutItems = await fetch(`${BASE}/items`, { redirect: "manual" });
    expect(loggedOutItems.status).toBe(302);
    expect(loggedOutItems.headers.get("location")).toBe("/login");
  });

  it("login success sets session and redirects", async () => {
    const res = await fetch(`${BASE}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "test@example.com", password: "password123" }).toString(),
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/items");
    expect(res.headers.get("set-cookie")).toContain("session=");
  });

  it("login failure returns error", async () => {
    const res = await fetch(`${BASE}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "test@example.com", password: "wrong" }).toString(),
    });
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).toContain("Invalid email or password");
  });

  it("logged-in session can open items and add one", async () => {
    const login = await fetch(`${BASE}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "test@example.com", password: "password123" }).toString(),
      redirect: "manual",
    });
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toMatch(/^session=/);

    const add = await fetch(`${BASE}/items`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie ?? "" },
      body: new URLSearchParams({ title: "Test item" }).toString(),
      redirect: "manual",
    });
    expect(add.status).toBe(302);

    const list = await fetch(`${BASE}/items`, { headers: { cookie: cookie ?? "" } });
    expect(list.status).toBe(200);
    expect(await list.text()).toContain("Test item");
  });

  it("tabs page opens items in a new tab, js-page renders price via script", async () => {
    const tabs = await fetch(`${BASE}/tabs`);
    const tabsHtml = await tabs.text();
    expect(tabsHtml).toContain('target="_blank"');
    expect(tabsHtml).toContain('href="/items"');

    const js = await fetch(`${BASE}/js-page`);
    const jsHtml = await js.text();
    expect(jsHtml).toContain("Loading...");
    expect(jsHtml).toContain("42 dollars");
  });
});
