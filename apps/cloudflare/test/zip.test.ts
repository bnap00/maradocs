// Zip parsing and packing (services/bundle.ts) against crafted archives, plus
// the publish upload contract and the streamed stored-zip download.
import { beforeAll, describe, expect, it } from "vitest";
import { deflateSync, unzipSync } from "fflate";
import { crc32 } from "node:zlib";
import { buildStoredZip, safeEntryName } from "../src/services/bundle";
import { parseMultipart } from "../src/services/multipart";
import {
  bearer,
  createApiKey,
  createRepo,
  env,
  fetchApp,
  json,
  login,
  nodeChecksum,
  publishRaw,
  uniqueSlug,
} from "./helpers";

let key: string;
let repo: string;

beforeAll(async () => {
  const { token } = await login();
  key = await createApiKey(token, ["publish", "read"]);
  repo = uniqueSlug("zipx");
  await createRepo(key, repo);
});

const enc = new TextEncoder();

interface CraftEntry {
  name: string;
  data: Uint8Array;
  deflate?: boolean;
  /** Overrides for what the central directory (and local header) declare. */
  declaredSize?: number;
  declaredCompressedSize?: number;
  crc?: number;
  flags?: number;
  /** Point this entry's central record at another entry's local header. */
  shareLocalWith?: number;
  zip64?: boolean;
}

/** Hand-built zip with full control over the declared metadata. */
function craftZip(entries: CraftEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  const offsets: number[] = [];
  let offset = 0;
  const records = entries.map((e) => {
    const name = enc.encode(e.name);
    const body = e.deflate ? deflateSync(e.data) : e.data;
    return {
      e,
      name,
      body,
      method: e.deflate ? 8 : 0,
      crc: e.crc ?? crc32(e.data) >>> 0,
      size: e.declaredSize ?? e.data.byteLength,
      comp: e.declaredCompressedSize ?? body.byteLength,
      flags: e.flags ?? 0x800,
    };
  });
  for (const r of records) {
    if (r.e.shareLocalWith !== undefined) {
      offsets.push(offsets[r.e.shareLocalWith]!);
      continue;
    }
    const local = new Uint8Array(30 + r.name.byteLength);
    const v = new DataView(local.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(6, r.flags, true);
    v.setUint16(8, r.method, true);
    v.setUint32(14, r.crc, true);
    v.setUint32(18, r.comp, true);
    v.setUint32(22, r.size, true);
    v.setUint16(26, r.name.byteLength, true);
    local.set(r.name, 30);
    offsets.push(offset);
    parts.push(local, r.body);
    offset += local.byteLength + r.body.byteLength;
  }
  const cdStart = offset;
  records.forEach((r, i) => {
    const extra = r.e.zip64 ? new Uint8Array(4 + 24) : new Uint8Array(0);
    if (r.e.zip64) {
      const xv = new DataView(extra.buffer);
      xv.setUint16(0, 0x0001, true);
      xv.setUint16(2, 24, true);
      xv.setBigUint64(4, BigInt(r.size), true);
      xv.setBigUint64(12, BigInt(r.comp), true);
      xv.setBigUint64(20, BigInt(offsets[i]!), true);
    }
    const rec = new Uint8Array(46 + r.name.byteLength + extra.byteLength);
    const v = new DataView(rec.buffer);
    v.setUint32(0, 0x02014b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(6, 20, true);
    v.setUint16(8, r.flags, true);
    v.setUint16(10, r.method, true);
    v.setUint32(16, r.crc, true);
    v.setUint32(20, r.e.zip64 ? 0xffffffff : r.comp, true);
    v.setUint32(24, r.e.zip64 ? 0xffffffff : r.size, true);
    v.setUint16(28, r.name.byteLength, true);
    v.setUint16(30, extra.byteLength, true);
    v.setUint32(42, r.e.zip64 ? 0xffffffff : offsets[i]!, true);
    rec.set(r.name, 46);
    rec.set(extra, 46 + r.name.byteLength);
    central.push(rec);
  });
  const cdSize = central.reduce((n, c) => n + c.byteLength, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdStart, true);
  const all = [...parts, ...central, eocd];
  const out = new Uint8Array(all.reduce((n, p) => n + p.byteLength, 0));
  let p = 0;
  for (const part of all) {
    out.set(part, p);
    p += part.byteLength;
  }
  return out;
}

async function expectRejected(zip: Uint8Array, message: RegExp | string, status = 400) {
  const doc = uniqueSlug("d");
  const res = await publishRaw(bearer(key), repo, doc, zip);
  const body = await json(res);
  expect(res.status, JSON.stringify(body)).toBe(status);
  if (typeof message === "string") expect(body.message).toBe(message);
  else expect(body.message).toMatch(message);
  // Nothing is created for a rejected bundle.
  expect(await env.DB.prepare(`SELECT id FROM documents WHERE slug = ?`).bind(doc).first()).toBeNull();
}

async function publishZip(zip: Uint8Array, doc = uniqueSlug("ok")) {
  const res = await publishRaw(bearer(key), repo, doc, zip);
  expect(res.status, await res.clone().text()).toBe(201);
  return { doc, result: await json(res) };
}

describe("declared sizes are enforced while inflating", () => {
  it("rejects an entry that inflates to more than it declares (no silent truncation)", async () => {
    const bomb = new Uint8Array(3 * 1024 * 1024); // 3 MB of zeros, a few KB deflated
    await expectRejected(
      craftZip([{ name: "index.html", data: bomb, deflate: true, declaredSize: 1 }]),
      "Bundle entry is larger than declared: index.html",
    );
  });

  it("rejects an entry that inflates to less than it declares", async () => {
    await expectRejected(
      craftZip([{ name: "index.html", data: enc.encode("short"), deflate: true, declaredSize: 50 }]),
      "Bundle entry is smaller than declared: index.html",
    );
  });

  it("rejects CRC mismatches in deflated and stored entries", async () => {
    await expectRejected(
      craftZip([{ name: "a.html", data: enc.encode("hello world"), deflate: true, crc: 1234 }]),
      "Bundle entry is corrupt (CRC mismatch): a.html",
    );
    await expectRejected(
      craftZip([{ name: "b.html", data: enc.encode("hello world"), crc: 1234 }]),
      "Bundle entry is corrupt (CRC mismatch): b.html",
    );
  });

  it("rejects stored entries whose sizes disagree, and corrupt deflate data", async () => {
    await expectRejected(
      craftZip([{ name: "a.html", data: enc.encode("abc"), declaredSize: 10 }]),
      "Bundle entry size mismatch: a.html",
    );
    const garbage = craftZip([{ name: "x.html", data: enc.encode("zzzz"), declaredSize: 4 }]);
    // Flip the method to deflate on both headers: the stored bytes aren't valid deflate data.
    const view = new DataView(garbage.buffer);
    view.setUint16(8, 8, true);
    const cd = garbage.byteLength - 22 - (46 + "x.html".length);
    view.setUint16(cd + 10, 8, true);
    await expectRejected(garbage, /^Bundle entry is (corrupt|smaller than declared)/);
  });

  it("rejects overlapping entries (several names sharing compressed data)", async () => {
    const zip = craftZip([
      { name: "a.html", data: enc.encode("x".repeat(100)), deflate: true },
      { name: "b.html", data: enc.encode("x".repeat(100)), deflate: true, shareLocalWith: 0 },
    ]);
    await expectRejected(zip, /^Bundle entries overlap/);
  });

  it("rejects encrypted entries and archives with bogus offsets", async () => {
    await expectRejected(
      craftZip([{ name: "a.html", data: enc.encode("x"), flags: 0x801 }]),
      "Encrypted bundle entries are not supported: a.html",
    );
    const zip = craftZip([{ name: "a.html", data: enc.encode("abc") }]);
    new DataView(zip.buffer).setUint32(zip.byteLength - 22 - (46 + 6) + 42, 999_999, true);
    await expectRejected(zip, "Uploaded bundle is not a valid zip archive");
  });
});

describe("well-formed archives", () => {
  it("accepts deflated and stored entries and reproduces the Node checksum", async () => {
    const files = { "index.html": "<h1>ok</h1>".repeat(500), "img/a.bin": new Uint8Array([0, 1, 2, 255]), "e.txt": "" };
    const zip = craftZip([
      { name: "index.html", data: enc.encode(files["index.html"]), deflate: true },
      { name: "img/a.bin", data: files["img/a.bin"] },
      { name: "e.txt", data: new Uint8Array(0), deflate: true },
    ]);
    const { doc, result } = await publishZip(zip);
    expect(result.fileCount).toBe(3);
    expect(result.checksum).toBe(await nodeChecksum(files));
    expect(await (await fetchApp(`/r/${repo}/${doc}/`)).text()).toBe(files["index.html"]);
  });

  it("reads zip64 central directory records", async () => {
    const zip = craftZip([{ name: "index.html", data: enc.encode("zip64"), zip64: true }]);
    const { doc } = await publishZip(zip);
    expect(await (await fetchApp(`/r/${repo}/${doc}/`)).text()).toBe("zip64");
  });

  it("decodes UTF-8 names even without the language-encoding flag", async () => {
    const zip = craftZip([
      { name: "index.html", data: enc.encode("i"), flags: 0 },
      { name: "naïve/報告.html", data: enc.encode("u"), flags: 0 },
    ]);
    const { doc } = await publishZip(zip);
    expect(await (await fetchApp(`/r/${repo}/${doc}/na%C3%AFve/%E5%A0%B1%E5%91%8A.html`)).text()).toBe("u");
  });

  it("keeps a file named __proto__", async () => {
    const zip = await buildStoredZip([
      ["__proto__", enc.encode("proto")],
      ["a.txt", enc.encode("a")],
    ]);
    const { doc, result } = await publishZip(zip);
    expect(result.fileCount).toBe(2);
    const expected = Object.create(null) as Record<string, string>;
    expected["__proto__"] = "proto";
    expected["a.txt"] = "a";
    expect(result.checksum).toBe(await nodeChecksum(expected));
    expect(await (await fetchApp(`/r/${repo}/${doc}/__proto__`)).text()).toBe("proto");
    const dl = await fetchApp(`/api/v1/repos/${repo}/docs/${doc}/bundle`, { headers: bearer(key) });
    const bytes = new Uint8Array(await dl.arrayBuffer());
    // fflate's unzip has the same __proto__ hazard; check the raw names instead.
    expect(new TextDecoder().decode(bytes)).toContain("__proto__");
  });

  it("normalises interior '..' segments like the Node server and rejects escapes", async () => {
    const zip = craftZip([
      { name: "index.html", data: enc.encode("i") },
      { name: "sub/x/../b.txt", data: enc.encode("b") },
    ]);
    const { doc } = await publishZip(zip);
    expect(await (await fetchApp(`/r/${repo}/${doc}/sub/b.txt`)).text()).toBe("b");
    expect(safeEntryName("a/../../evil")).toBeNull();
    expect(safeEntryName("a/b/../../c")).toBe("c");
    expect(safeEntryName("./x/./y")).toBe("x/y");
    await expectRejected(
      craftZip([{ name: "x/../../evil.html", data: enc.encode("e") }]),
      /^Unsafe path in bundle/,
    );
  });

  it("rejects names with control characters", async () => {
    await expectRejected(craftZip([{ name: "bad\u0007name.html", data: enc.encode("x") }]), /^Unsafe path in bundle/);
    await expectRejected(craftZip([{ name: "tab\tname.html", data: enc.encode("x") }]), /^Unsafe path in bundle/);
  });
});

describe("multipart parsing", () => {
  const body = (text: string) => enc.encode(text);

  it("parses fields and files from a standard body (preamble, quoted boundary, UTF-8)", () => {
    const raw =
      "preamble\r\n--b0und\r\n" +
      'Content-Disposition: form-data; name="doc"\r\n\r\nhello\r\n' +
      "--b0und\r\n" +
      'Content-Disposition: form-data; name="title"\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nRépört\r\n' +
      "--b0und\r\n" +
      'Content-Disposition: form-data; name="file"; filename="a \\"b\\".zip"\r\nContent-Type: application/zip\r\n\r\nPK\r\n--not-it\r\n' +
      "--b0und--\r\n";
    const parsed = parseMultipart(body(raw), 'multipart/form-data; boundary="b0und"');
    expect(parsed.fields).toEqual({ doc: "hello", title: "Répört" });
    const file = parsed.files.get("file")!;
    expect(file.filename).toBe('a "b".zip');
    expect(new TextDecoder().decode(file.data)).toBe("PK\r\n--not-it");
  });

  it("rejects malformed bodies", () => {
    for (const raw of ["no delimiter", "--x\r\nContent-Disposition: form-data; name=a\r\n\r\nunterminated", "--xjunk"]) {
      expect(() => parseMultipart(body(raw), "multipart/form-data; boundary=x"), raw).toThrow("Expected a multipart upload");
    }
    expect(() => parseMultipart(body("--x--"), "text/plain")).toThrow("Expected a multipart upload");
    expect(parseMultipart(body("--x--"), "multipart/form-data; boundary=x").fields).toEqual({});
  });
});

describe("upload contract", () => {
  it("requires a Content-Length before buffering the body", async () => {
    const form = new FormData();
    form.append("doc", "chunked");
    form.append("file", new Blob([craftZip([{ name: "index.html", data: enc.encode("x") }])]), "b.zip");
    const serialized = new Response(form);
    const type = serialized.headers.get("content-type")!;
    const bytes = new Uint8Array(await serialized.arrayBuffer());
    // A plain ReadableStream has no known length, like a chunked upload.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const res = await fetchApp(`/api/v1/repos/${repo}/docs`, {
      method: "POST",
      headers: bearer(key, { "content-type": type }),
      body,
      // @ts-expect-error -- duplex is required for streaming request bodies
      duplex: "half",
    });
    expect(res.status).toBe(411);
    expect((await json(res)).error).toBe("length_required");
  });

  it("rejects a declared length above the limit without reading the body", async () => {
    const res = await fetchApp(`/api/v1/repos/${repo}/docs`, {
      method: "POST",
      headers: bearer(key, { "content-type": "multipart/form-data; boundary=x", "content-length": String(50 * 1024 * 1024) }),
      body: "--x--",
    });
    expect(res.status).toBe(413);
  });
});

describe("download", () => {
  it("streams a stored zip (no JS deflate) that round-trips", async () => {
    const files = { "index.html": "<p>dl</p>".repeat(200), "css/a.css": "a{}" };
    const zip = craftZip([
      { name: "index.html", data: enc.encode(files["index.html"]), deflate: true },
      { name: "css/a.css", data: enc.encode(files["css/a.css"]), deflate: true },
    ]);
    const { doc, result } = await publishZip(zip);
    const res = await fetchApp(`/api/v1/repos/${repo}/docs/${doc}/bundle`, { headers: bearer(key) });
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(res.headers.get("content-length")).toBe(String(bytes.byteLength));
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(8, true)).toBe(0); // stored
    const out = unzipSync(bytes);
    expect(new TextDecoder().decode(out["index.html"])).toBe(files["index.html"]);
    expect(new TextDecoder().decode(out["css/a.css"])).toBe(files["css/a.css"]);
    expect(res.headers.get("x-maradocs-checksum")).toBe(result.checksum);
  });

  it("downloads versions whose manifest predates recorded CRCs", async () => {
    const files = { "index.html": "legacy", "b.txt": "bee" };
    const { doc } = await publishZip(craftZip([
      { name: "index.html", data: enc.encode(files["index.html"]) },
      { name: "b.txt", data: enc.encode(files["b.txt"]), deflate: true },
    ]));
    const row = await env.DB.prepare(
      `SELECT v.id, v.manifest FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE d.slug = ?`,
    )
      .bind(doc)
      .first<{ id: string; manifest: string }>();
    const legacy = Object.fromEntries(
      Object.entries(JSON.parse(row!.manifest) as Record<string, number[]>).map(([k, v]) => [k, v.slice(0, 2)]),
    );
    await env.DB.prepare(`UPDATE document_versions SET manifest = ? WHERE id = ?`).bind(JSON.stringify(legacy), row!.id).run();
    const res = await fetchApp(`/api/v1/repos/${repo}/docs/${doc}/bundle`, { headers: bearer(key) });
    expect(res.status).toBe(200);
    const out = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(new TextDecoder().decode(out["b.txt"])).toBe("bee");
  });

  it("sends Unicode entrypoints percent-encoded instead of failing", async () => {
    const zip = craftZip([{ name: "报告.html", data: enc.encode("report") }]);
    const { doc } = await publishZip(zip);
    const res = await fetchApp(`/api/v1/repos/${repo}/docs/${doc}/bundle`, { headers: bearer(key) });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-maradocs-entrypoint")).toBeNull();
    expect(res.headers.get("x-maradocs-entrypoint-encoded")).toBe(encodeURIComponent("报告.html"));
    await res.arrayBuffer();
    // ASCII names keep the plain header too (wire compatibility).
    const ascii = await publishZip(craftZip([{ name: "index.html", data: enc.encode("i") }]));
    const plain = await fetchApp(`/api/v1/repos/${repo}/docs/${ascii.doc}/bundle`, { headers: bearer(key) });
    expect(plain.headers.get("x-maradocs-entrypoint")).toBe("index.html");
    expect(plain.headers.get("x-maradocs-entrypoint-encoded")).toBe("index.html");
    await plain.arrayBuffer();
  });
});

describe("names shadowed by report URL routing", () => {
  it("rejects a top-level directory shaped like a capability token", async () => {
    await expectRejected(
      craftZip([
        { name: "index.html", data: enc.encode("i") },
        { name: `~p.abc.${"A".repeat(22)}/x.css`, data: enc.encode("x") },
      ]),
      /^Unsupported file name in bundle/,
    );
    // Ordinary names starting with "~" are fine.
    const { doc } = await publishZip(craftZip([{ name: "~notes/index.html", data: enc.encode("n") }]));
    expect(await (await fetchApp(`/r/${repo}/${doc}/~notes/`)).text()).toBe("n");
  });
});
