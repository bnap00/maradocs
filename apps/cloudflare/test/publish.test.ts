import { beforeAll, describe, expect, it } from "vitest";
import { zipSync } from "fflate";
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
  makeZip,
  nodeChecksum,
  publish,
  publishRaw,
  uniqueSlug,
  uploadForm,
} from "./helpers";

let session: string;
let key: string;

beforeAll(async () => {
  session = (await login()).token;
  key = await createApiKey(session, ["publish"]);
});

const SITE = { "index.html": "<h1>v1</h1>", "css/site.css": "body{color:red}" };

describe("repositories (machine API)", () => {
  it("creates, lists and updates repositories with server-identical shapes", async () => {
    const slug = uniqueSlug("repo");
    const created = await machineJson(key, "POST", "/repos", {
      slug,
      name: "Weekly reports",
      description: "From CI",
      access: "public",
      indexEnabled: true,
    });
    expect(created.status).toBe(201);
    const { repo } = await json(created);
    expect(Object.keys(repo).sort()).toEqual(
      ["id", "slug", "name", "description", "defaultAccess", "indexEnabled", "hasPassword", "createdAt", "updatedAt"].sort(),
    );
    expect(repo).toMatchObject({ slug, name: "Weekly reports", defaultAccess: "public", indexEnabled: true, hasPassword: false });

    const dup = await machineJson(key, "POST", "/repos", { slug });
    expect(dup.status).toBe(409);
    expect((await json(dup)).error).toBe("conflict");

    const list = await json(await machineJson(key, "GET", "/repos"));
    expect(list.repos.some((r: { slug: string }) => r.slug === slug)).toBe(true);

    const patched = await machineJson(key, "PATCH", `/repos/${slug}`, { access: "password", password: "hunter22" });
    expect(patched.status).toBe(200);
    expect((await json(patched)).repo).toMatchObject({ defaultAccess: "password", hasPassword: true });

    const noPw = await machineJson(key, "PATCH", `/repos/${slug}`, { password: null });
    expect(noPw.status).toBe(400);

    const events = await auditEvents({ repo: slug });
    expect(events).toEqual(["repo.create", "access.change"]);
  });

  it("uses the configured default access and requires a password for password repos", async () => {
    const slug = uniqueSlug("defacc");
    const res = await machineJson(key, "POST", "/repos", { slug });
    expect((await json(res)).repo.defaultAccess).toBe("private");
    const bad = await machineJson(key, "POST", "/repos", { slug: uniqueSlug("pw"), access: "password" });
    expect(bad.status).toBe(400);
    expect((await json(bad)).error).toBe("bad_request");
  });

  it("validates slugs in bodies and route params", async () => {
    const bad = await machineJson(key, "POST", "/repos", { slug: "Not_A_Slug" });
    expect(bad.status).toBe(400);
    expect((await json(bad)).error).toBe("validation_error");
    for (const path of ["/repos/Bad_Slug/docs", "/repos/..%2F..%2Fetc/docs", "/repos/a--b-/docs"]) {
      const res = await machineJson(key, "GET", path);
      expect(res.status).toBe(404);
      expect((await json(res)).error).toBe("not_found");
    }
  });

  it("requires the publish scope for writes", async () => {
    const readKey = await createApiKey(session, ["read"]);
    const res = await machineJson(readKey, "POST", "/repos", { slug: uniqueSlug("scope") });
    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ error: "forbidden", message: "API key missing required scope: publish" });
    expect((await machineJson(readKey, "GET", "/repos")).status).toBe(200);
    const adminKey = await createApiKey(session, ["admin"]);
    expect((await machineJson(adminKey, "POST", "/repos", { slug: uniqueSlug("admin"), access: "public" })).status).toBe(201);
  });

  it("rejects missing or invalid API keys", async () => {
    const missing = await fetchApp("/api/v1/repos");
    expect(missing.status).toBe(401);
    expect(await json(missing)).toMatchObject({ error: "unauthorized", message: "Missing API key" });
    const invalid = await fetchApp("/api/v1/repos", { headers: bearer("mdo_nope") });
    expect(invalid.status).toBe(401);
    expect((await json(invalid)).message).toBe("Invalid or expired API key");
  });
});

describe("publishing", () => {
  it("publishes v1 with a server-compatible PublishResult and checksum", async () => {
    const repo = uniqueSlug("pub");
    await createRepo(key, repo);
    const result = await publish(key, repo, "report", SITE, { title: "Report" });
    expect(Object.keys(result).sort()).toEqual(
      ["repo", "doc", "versionNumber", "access", "url", "versionUrl", "fileCount", "sizeBytes", "checksum"].sort(),
    );
    expect(result).toMatchObject({
      repo,
      doc: "report",
      versionNumber: 1,
      access: "public",
      url: `https://maradocs.test/r/${repo}/report/`,
      versionUrl: `https://maradocs.test/r/${repo}/report/v/1/`,
      fileCount: 2,
      sizeBytes: SITE["index.html"].length + SITE["css/site.css"].length,
    });
    expect(result.checksum).toBe(await nodeChecksum(SITE));

    const docs = await json(await machineJson(key, "GET", `/repos/${repo}/docs`));
    expect(docs.docs).toHaveLength(1);
    expect(Object.keys(docs.docs[0]).sort()).toEqual(
      ["id", "repositorySlug", "slug", "title", "access", "accessOverride", "entrypoint", "latestVersionNumber", "hasPassword", "url", "createdAt", "updatedAt"].sort(),
    );
    expect(docs.docs[0]).toMatchObject({ slug: "report", title: "Report", latestVersionNumber: 1, accessOverride: null });
  });

  it("returns 404 for a missing repo, 409 for an existing doc on POST, 404 for a missing doc on PUT", async () => {
    const missingRepo = await publishRaw(bearer(key), uniqueSlug("nope"), "doc", makeZip(SITE));
    expect(missingRepo.status).toBe(404);
    expect((await json(missingRepo)).message).toMatch(/^Repository '.*' not found$/);

    const repo = uniqueSlug("codes");
    await createRepo(key, repo);
    await publish(key, repo, "doc", SITE);
    const dup = await publishRaw(bearer(key), repo, "doc", makeZip(SITE));
    expect(dup.status).toBe(409);
    expect((await json(dup)).error).toBe("conflict");
    const missingDoc = await publishRaw(bearer(key), repo, "other", makeZip(SITE), { replace: true });
    expect(missingDoc.status).toBe(404);
  });

  it("replaces documents with incrementing version numbers and keeps settings", async () => {
    const repo = uniqueSlug("ver");
    await createRepo(key, repo);
    await publish(key, repo, "doc", SITE, { title: "First", access: "private" });
    const v2 = await publish(key, repo, "doc", { "index.html": "<h1>v2</h1>" }, { replace: true });
    expect(v2).toMatchObject({ versionNumber: 2, access: "private", fileCount: 1 });
    const v3 = await publish(key, repo, "doc", { "index.html": "<h1>v3</h1>" }, { replace: true, title: "Third" });
    expect(v3.versionNumber).toBe(3);

    const { versions } = await json(await machineJson(key, "GET", `/repos/${repo}/docs/doc/versions`));
    expect(versions.map((v: { versionNumber: number }) => v.versionNumber)).toEqual([3, 2, 1]);
    expect(versions.map((v: { isLatest: boolean }) => v.isLatest)).toEqual([true, false, false]);
    expect(Object.keys(versions[0]).sort()).toEqual(
      ["id", "documentId", "versionNumber", "checksum", "fileCount", "sizeBytes", "entrypoint", "publishedByType", "publishedById", "publishedByLabel", "isLatest", "createdAt"].sort(),
    );
    expect(versions[0]).toMatchObject({ publishedByType: "machine", publishedByLabel: "test-key" });
    const { docs } = await json(await machineJson(key, "GET", `/repos/${repo}/docs`));
    expect(docs[0]).toMatchObject({ title: "Third", access: "private", accessOverride: "private", latestVersionNumber: 3 });
    expect(await auditEvents({ repo })).toEqual(["repo.create", "doc.publish", "doc.replace", "doc.replace"]);
  });

  it("accepts the bundle under the 'bundle' field and treats empty optional fields as absent", async () => {
    const repo = uniqueSlug("field");
    await createRepo(key, repo);
    const form = uploadForm({ doc: "doc", title: "", access: "", entrypoint: "" }, makeZip(SITE), "bundle");
    const res = await fetchApp(`/api/v1/repos/${repo}/docs`, { method: "POST", headers: bearer(key), body: form });
    expect(res.status).toBe(201);
    const { docs } = await json(await machineJson(key, "GET", `/repos/${repo}/docs`));
    expect(docs[0].title).toBe("doc");
  });

  it("validates multipart input", async () => {
    const repo = uniqueSlug("mp");
    await createRepo(key, repo);
    const noFile = await fetchApp(`/api/v1/repos/${repo}/docs`, {
      method: "POST",
      headers: bearer(key),
      body: uploadForm({ doc: "doc" }),
    });
    expect(noFile.status).toBe(400);
    expect(await json(noFile)).toMatchObject({ error: "bad_request", message: "Missing document bundle (field 'file')" });
    const notMultipart = await machineJson(key, "POST", `/repos/${repo}/docs`, { doc: "doc" });
    expect(notMultipart.status).toBe(400);
    expect((await json(notMultipart)).message).toBe("Expected a multipart upload");
    const badSlug = await publishRaw(bearer(key), repo, "Bad Slug", makeZip(SITE));
    expect(badSlug.status).toBe(400);
    expect((await json(badSlug)).error).toBe("validation_error");
    const badAccess = await publishRaw(bearer(key), repo, "doc", makeZip(SITE), { access: "secret" });
    expect(badAccess.status).toBe(400);
    const shortPw = await publishRaw(bearer(key), repo, "doc", makeZip(SITE), { access: "password", password: "abc" });
    expect(shortPw.status).toBe(400);
    const pwRequired = await publishRaw(bearer(key), repo, "doc", makeZip(SITE), { access: "password" });
    expect(pwRequired.status).toBe(400);
    expect((await json(pwRequired)).message).toBe("A password is required when access is 'password'");
  });

  it("resolves entrypoints like the server", async () => {
    const repo = uniqueSlug("entry");
    await createRepo(key, repo);
    await publish(key, repo, "requested", { "index.html": "i", "report.html": "r" }, { entrypoint: "report.html" });
    await publish(key, repo, "shallow", { "deep/nested/a.html": "a", "top.html": "t", "x.txt": "x" });
    await publish(key, repo, "missing-request", { "index.html": "i" }, { entrypoint: "nope.html" });
    await publish(key, repo, "no-html", { "data.json": "{}" });
    const { docs } = await json(await machineJson(key, "GET", `/repos/${repo}/docs`));
    const entry = Object.fromEntries(docs.map((d: { slug: string; entrypoint: string }) => [d.slug, d.entrypoint]));
    expect(entry).toEqual({
      requested: "report.html",
      shallow: "top.html",
      "missing-request": "index.html",
      "no-html": "index.html",
    });
    const res = await fetchApp(`/r/${repo}/shallow/`);
    expect(await res.text()).toBe("t");
  });

  it("assigns distinct version numbers to concurrent publishes", async () => {
    const repo = uniqueSlug("race");
    await createRepo(key, repo);
    await publish(key, repo, "doc", SITE);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        publishRaw(bearer(key), repo, "doc", makeZip({ "index.html": `<p>${i}</p>` }), { replace: true }),
      ),
    );
    const bodies = await Promise.all(results.map((r) => json(r)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const numbers = bodies.map((b) => b.versionNumber).sort((a, b) => a - b);
    expect(numbers).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    const { versions } = await json(await machineJson(key, "GET", `/repos/${repo}/docs/doc/versions`));
    expect(versions).toHaveLength(9);
    expect(new Set(versions.map((v: { versionNumber: number }) => v.versionNumber)).size).toBe(9);
    const latest = versions.filter((v: { isLatest: boolean }) => v.isLatest);
    expect(latest).toHaveLength(1);
  });

  it("lets exactly one concurrent create win; the rest get 409 and leave no blobs behind", async () => {
    const repo = uniqueSlug("create-race");
    await createRepo(key, repo);
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => publishRaw(bearer(key), repo, "doc", makeZip({ "index.html": `${i}` }))),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409]);
    await Promise.all(results.map((r) => r.arrayBuffer()));
    const { versions } = await json(await machineJson(key, "GET", `/repos/${repo}/docs/doc/versions`));
    expect(versions).toHaveLength(1);
    // Allow background cleanup of losing uploads to finish.
    const deadline = Date.now() + 3000;
    let listed = await env.BUCKET.list({ prefix: "versions/", limit: 1000 });
    const known = new Set(
      (await env.DB.prepare(`SELECT storage_path FROM document_versions`).all<{ storage_path: string }>()).results.map(
        (r) => r.storage_path,
      ),
    );
    while (listed.objects.some((o) => o.customMetadata?.repo === repo && !known.has(o.key)) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      listed = await env.BUCKET.list({ prefix: "versions/", limit: 1000, include: ["customMetadata"] });
    }
    listed = await env.BUCKET.list({ prefix: "versions/", limit: 1000, include: ["customMetadata"] });
    const orphans = listed.objects.filter((o) => o.customMetadata?.repo === repo && !known.has(o.key));
    expect(orphans).toHaveLength(0);
  });
});

describe("zip safety", () => {
  let repo: string;
  beforeAll(async () => {
    repo = uniqueSlug("zip");
    await createRepo(key, repo);
  });

  async function expectRejected(zip: Uint8Array, status: number, message: RegExp | string) {
    const res = await publishRaw(bearer(key), repo, uniqueSlug("d"), zip);
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(status);
    expect(body.error).toBe(status === 413 ? "payload_too_large" : "bad_request");
    if (typeof message === "string") expect(body.message).toBe(message);
    else expect(body.message).toMatch(message);
  }

  it("rejects path traversal and absolute paths", async () => {
    await expectRejected(makeZip({ "index.html": "x", "../evil.html": "x" }), 400, /^Unsafe path in bundle/);
    await expectRejected(makeZip({ "a/../../evil.html": "x" }), 400, /^Unsafe path in bundle/);
    await expectRejected(makeZip({ "/etc/passwd": "x" }), 400, /^Unsafe path in bundle/);
    await expectRejected(makeZip({ "C:/windows/evil.html": "x" }), 400, /^Unsafe path in bundle/);
    await expectRejected(makeZip({ "..\\evil.html": "x" }), 400, /^Unsafe path in bundle/);
    await expectRejected(makeZip({ "a\0b.html": "x" }), 400, /^Unsafe path in bundle/);
  });

  it("rejects duplicates, too many files, overly long or deep paths", async () => {
    await expectRejected(makeZip({ "a.html": "1", "./a.html": "2" }), 400, /^Duplicate path in bundle/);
    const many: Record<string, string> = {};
    for (let i = 0; i < 2001; i += 1) many[`f${i}.txt`] = "";
    await expectRejected(makeZip(many), 400, "Bundle contains more than 2000 files");
    await expectRejected(makeZip({ [`${"a".repeat(241)}.html`]: "x" }), 400, /^Path is too deep or too long/);
    await expectRejected(makeZip({ [`${Array.from({ length: 21 }, () => "d").join("/")}.html`]: "x" }), 400, /^Path is too deep or too long/);
  });

  it("rejects empty bundles and non-zip uploads", async () => {
    await expectRejected(zipSync({}), 400, "Bundle is empty");
    await expectRejected(makeZip({ "only-dir/": new Uint8Array(0) }), 400, "Bundle is empty");
    await expectRejected(new TextEncoder().encode("definitely not a zip"), 400, "Uploaded bundle is not a valid zip archive");
  });

  it("rejects bundles whose uncompressed size exceeds the limit before inflating", async () => {
    // 3 MB of zeros compresses to a few KB; MAX_UPLOAD_MB is 2 in tests.
    await expectRejected(makeZip({ "big.bin": new Uint8Array(3 * 1024 * 1024) }), 413, "Bundle exceeds the maximum upload size");
  });

  it("rejects uploads larger than the limit", async () => {
    const noise = crypto.getRandomValues(new Uint8Array(65536));
    const big = new Uint8Array(2 * 1024 * 1024 + 10);
    for (let i = 0; i < big.length; i += noise.length) big.set(noise.subarray(0, Math.min(noise.length, big.length - i)), i);
    const res = await publishRaw(bearer(key), repo, "too-big", big);
    expect(res.status).toBe(413);
    expect((await json(res)).error).toBe("payload_too_large");
  });

  it("does not create documents or versions for rejected bundles", async () => {
    const doc = uniqueSlug("rejected");
    await publishRaw(bearer(key), repo, doc, makeZip({ "../x": "x" }));
    const row = await env.DB.prepare(`SELECT id FROM documents WHERE slug = ?`).bind(doc).first();
    expect(row).toBeNull();
  });

  it("normalises safe names (./ prefixes, backslashes)", async () => {
    const doc = uniqueSlug("norm");
    const res = await publishRaw(bearer(key), repo, doc, makeZip({ "./index.html": "i", "sub\\page.html": "p" }));
    expect(res.status).toBe(201);
    expect(await (await fetchApp(`/r/${repo}/${doc}/sub/page.html`)).text()).toBe("p");
  });
});
