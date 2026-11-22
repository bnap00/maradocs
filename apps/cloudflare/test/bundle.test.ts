import { beforeAll, describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import {
  auditEvents,
  bearer,
  createApiKey,
  createRepo,
  env,
  fetchApp,
  json,
  login,
  machineJson,
  nodeChecksum,
  publish,
  toBytes,
  uniqueSlug,
  type FileMap,
} from "./helpers";

let session: string;
let key: string;

beforeAll(async () => {
  session = (await login()).token;
  key = await createApiKey(session, ["publish"]);
});

const FILES: FileMap = {
  "index.html": "<!doctype html><h1>Round trip</h1>",
  "assets/app.js": "console.log('hello')",
  "img/pixel.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 255]),
  "empty.txt": "",
  "unicodé/naïve.txt": "ünïcødé",
};

describe("bundle download", () => {
  it("round-trips files and matches the Node server checksum", async () => {
    const repo = uniqueSlug("dl");
    await createRepo(key, repo);
    const published = await publish(key, repo, "doc", FILES);
    const res = await fetchApp(`/api/v1/repos/${repo}/docs/doc/bundle`, { headers: bearer(key) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="${repo}-doc-v1.zip"`);
    expect(res.headers.get("x-maradocs-version-number")).toBe("1");
    expect(res.headers.get("x-maradocs-entrypoint")).toBe("index.html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const checksum = res.headers.get("x-maradocs-checksum");
    expect(checksum).toBe(published.checksum);
    expect(checksum).toBe(await nodeChecksum(FILES));

    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(Object.keys(FILES).sort());
    for (const [path, content] of Object.entries(FILES)) expect(files[path]).toEqual(toBytes(content));
    // Re-publishing the downloaded bundle yields the same checksum.
    const republished = await publish(key, repo, "copy", Object.fromEntries(Object.entries(files)));
    expect(republished.checksum).toBe(published.checksum);
  });

  it("downloads pinned versions and reports missing ones", async () => {
    const repo = uniqueSlug("dlv");
    await createRepo(key, repo);
    await publish(key, repo, "doc", { "index.html": "v1" });
    await publish(key, repo, "doc", { "index.html": "v2" }, { replace: true });
    const v1 = await fetchApp(`/api/v1/repos/${repo}/docs/doc/bundle?version=1`, { headers: bearer(key) });
    expect(v1.headers.get("x-maradocs-version-number")).toBe("1");
    expect(new TextDecoder().decode(unzipSync(new Uint8Array(await v1.arrayBuffer()))["index.html"])).toBe("v1");
    const latest = await fetchApp(`/api/v1/repos/${repo}/docs/doc/bundle`, { headers: bearer(key) });
    expect(latest.headers.get("x-maradocs-version-number")).toBe("2");
    await latest.arrayBuffer();
    const missing = await fetchApp(`/api/v1/repos/${repo}/docs/doc/bundle?version=9`, { headers: bearer(key) });
    expect(missing.status).toBe(404);
    expect((await json(missing)).message).toBe(`Version 9 of '${repo}/doc' not found`);
    const invalid = await fetchApp(`/api/v1/repos/${repo}/docs/doc/bundle?version=abc`, { headers: bearer(key) });
    expect(invalid.status).toBe(400);
    expect((await json(invalid)).error).toBe("validation_error");
  });

  it("allows read-scoped keys", async () => {
    const repo = uniqueSlug("dlscope");
    await createRepo(key, repo);
    await publish(key, repo, "doc", { "index.html": "x" });
    const readKey = await createApiKey(session, ["read"]);
    const res = await fetchApp(`/api/v1/repos/${repo}/docs/doc/bundle`, { headers: bearer(readKey) });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
  });
});

describe("rollback", () => {
  it("promotes an older version to latest", async () => {
    const repo = uniqueSlug("rb");
    await createRepo(key, repo);
    await publish(key, repo, "doc", { "index.html": "first" });
    await publish(key, repo, "doc", { "main.html": "second" }, { replace: true });
    expect(await (await fetchApp(`/r/${repo}/doc/`)).text()).toBe("second");

    const res = await machineJson(key, "POST", `/repos/${repo}/docs/doc/rollback`, { version: 1 });
    expect(res.status).toBe(200);
    const { doc } = await json(res);
    expect(doc).toMatchObject({ slug: "doc", latestVersionNumber: 1, entrypoint: "index.html", url: `https://maradocs.test/r/${repo}/doc/` });
    expect(await (await fetchApp(`/r/${repo}/doc/`)).text()).toBe("first");

    const { versions } = await json(await machineJson(key, "GET", `/repos/${repo}/docs/doc/versions`));
    expect(versions.find((v: { isLatest: boolean }) => v.isLatest).versionNumber).toBe(1);

    // Next publish continues numbering after the highest version.
    const v3 = await publish(key, repo, "doc", { "index.html": "third" }, { replace: true });
    expect(v3.versionNumber).toBe(3);
    expect(await auditEvents({ repo, event: "doc.rollback" })).toHaveLength(1);
  });

  it("validates the version and requires publish scope", async () => {
    const repo = uniqueSlug("rbv");
    await createRepo(key, repo);
    await publish(key, repo, "doc", { "index.html": "x" });
    const missing = await machineJson(key, "POST", `/repos/${repo}/docs/doc/rollback`, { version: 5 });
    expect(missing.status).toBe(404);
    expect((await json(missing)).message).toBe("Version 5 not found");
    const invalid = await machineJson(key, "POST", `/repos/${repo}/docs/doc/rollback`, { version: 0 });
    expect(invalid.status).toBe(400);
    const readKey = await createApiKey(session, ["read"]);
    expect((await machineJson(readKey, "POST", `/repos/${repo}/docs/doc/rollback`, { version: 1 })).status).toBe(403);
  });
});

describe("delete", () => {
  it("deletes a document, its versions and its blobs", async () => {
    const repo = uniqueSlug("del");
    await createRepo(key, repo);
    await publish(key, repo, "doc", { "index.html": "a" });
    await publish(key, repo, "doc", { "index.html": "b" }, { replace: true });
    await publish(key, repo, "keep", { "index.html": "keep" });
    const { results } = await env.DB.prepare(
      `SELECT v.storage_path FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE d.slug = 'doc'
       AND d.repository_id = (SELECT id FROM repositories WHERE slug = ?)`,
    )
      .bind(repo)
      .all<{ storage_path: string }>();
    expect(results).toHaveLength(2);
    for (const r of results) expect(await env.BUCKET.head(r.storage_path)).not.toBeNull();

    const res = await machineJson(key, "DELETE", `/repos/${repo}/docs/doc`);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ deleted: true });

    for (const r of results) expect(await env.BUCKET.head(r.storage_path)).toBeNull();
    const versions = await env.DB.prepare(`SELECT COUNT(*) AS n FROM document_versions WHERE storage_path IN (?, ?)`)
      .bind(results[0]!.storage_path, results[1]!.storage_path)
      .first<{ n: number }>();
    expect(versions?.n).toBe(0);
    expect((await fetchApp(`/r/${repo}/doc/`)).status).toBe(404);
    expect(await (await fetchApp(`/r/${repo}/keep/`)).text()).toBe("keep");
    expect((await machineJson(key, "DELETE", `/repos/${repo}/docs/doc`)).status).toBe(404);
    expect(await auditEvents({ repo, event: "doc.delete" })).toHaveLength(1);
  });
});
