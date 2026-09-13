// Drives the real page in headless Chrome and asserts by reading the DOM.
//
// The node suites in test/ prove the engine and the contract; nothing there
// opens a browser, so nothing there can tell whether the page is wired to the
// engine at all. This one loads index.html, waits for the runtime, clicks the
// controls a visitor clicks, and checks what the page actually rendered.
//
//   node web/scripts/ui-probe.mjs --base http://127.0.0.1:8790/ [--shots DIR]
//
// It needs `make serve` in another shell, and Chrome on the PATH or in $CHROME.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";

const CHROME =
  process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.CDP_PORT ?? 9455);

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}

const base = arg("base", "http://127.0.0.1:8790/");
const shots = arg("shots", null);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "--window-size=1560,1100",
    `--user-data-dir=/tmp/unswell-ui-probe-${PORT}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

const getJSON = (path) =>
  new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port: PORT, path }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on("error", reject);
  });

async function connect() {
  for (let i = 0; i < 80; i++) {
    try {
      const page = (await getJSON("/json/list")).find((t) => t.type === "page");
      if (page) return page;
    } catch {
      // Chrome has not opened the port yet.
    }
    await sleep(250);
  }
  throw new Error("Chrome never answered on the DevTools port");
}

const checks = [];
function check(ok, name, detail = "") {
  checks.push({ ok, name, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`);
}

async function main() {
  const target = await connect();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const logs = [];

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    });

  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      const { resolve, reject } = pending.get(d.id);
      pending.delete(d.id);
      if (d.error) reject(new Error(d.error.message));
      else resolve(d.result);
      return;
    }
    if (d.method === "Runtime.consoleAPICalled") {
      logs.push(
        `[${d.params.type}] ` +
          d.params.args.map((a) => a.value ?? a.description ?? a.type).join(" "),
      );
    }
    if (d.method === "Runtime.exceptionThrown") {
      logs.push(
        `[exception] ${d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text}`,
      );
    }
  };

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  await send("Runtime.enable");
  await send("Page.enable");

  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result?.value;
  };

  await send("Page.navigate", { url: `${base}index.html` });
  await sleep(600);

  /* ---------- The page is meaningful before the runtime loads ---------- */

  check(
    (await evaluate('document.querySelector("h1").textContent.trim()')) ===
      "Paste a paragraph. Watch the residue surface.",
    "the headline is in the HTML, not painted by script",
  );
  check(
    (await evaluate('document.getElementById("input") !== null')) === true,
    "the editor exists before any WebAssembly arrives",
  );

  /* ---------- The runtime boots ---------- */

  const until = Date.now() + 180_000;
  let state = "";
  for (;;) {
    state = await evaluate('document.getElementById("engine").dataset.state');
    if (state === "ready" || state === "failed" || Date.now() > until) break;
    await sleep(400);
  }
  const detail = await evaluate('document.getElementById("engine-detail").textContent');
  check(state === "ready", "the engine reaches ready", `state=${state} detail=${detail}`);
  check(
    /ready in \d+ ms · offline/.test(detail),
    "the engine strip reports a measured boot time",
    detail,
  );
  check(
    /unswell v\d.*40 rules.*go1\./.test(await evaluate('document.getElementById("footer-tag").textContent')),
    "the footer states the build that is actually running",
    await evaluate('document.getElementById("footer-tag").textContent'),
  );

  /* ---------- Loading a sample analyzes it ---------- */

  await evaluate('document.getElementById("load-sample").click()');
  await waitForReport(evaluate);

  const report = await evaluate(`JSON.stringify({
    marks: document.querySelectorAll("#report .mark").length,
    notes: document.querySelectorAll(".note").length,
    paras: document.querySelectorAll(".para").length,
    gate: document.querySelector(".stat-value").textContent,
    index: document.querySelectorAll(".stat-value")[1].textContent,
    count: document.getElementById("rail-count").textContent,
    button: document.getElementById("analyze").textContent,
    firstNote: document.querySelector(".note-rule")?.textContent ?? "",
    firstMeta: document.querySelector(".note-meta")?.textContent ?? "",
    bands: [...document.querySelectorAll(".para")].map(p => p.dataset.band),
    stretch: document.querySelectorAll("#report .mark.is-stretch").length,
    indices: [...document.querySelectorAll(".mark-index")].map(s => s.textContent),
  })`);
  const r = JSON.parse(report);

  check(r.marks > 0, "the AI-flavored sample is marked in the document", `${r.marks} mark element(s)`);
  check(r.notes >= 12, "every finding has a note in the rail", `${r.notes} note(s)`);
  check(r.paras >= 5, "the document is segmented into paragraphs", `${r.paras} paragraph(s)`);
  check(r.gate === "FAIL", "the gate card reports the engine's decision", r.gate);
  check(/\d+(\.\d)? \/ 100/.test(r.index), "the max index card shows a score out of 100", r.index);
  check(/^\d+ · technical$/.test(r.count), "the rail header counts the findings", r.count);
  check(r.button.trim() === "Edit text", "the primary action becomes Edit text", r.button);
  check(r.firstNote.includes("."), "a note names its rule", r.firstNote);
  check(
    /(forbid|warning|info).*pts/.test(r.firstMeta),
    "a note's meta line carries the severity and the points",
    r.firstMeta,
  );
  check(
    r.bands.some((b) => b === "high" || b === "mid"),
    "at least one paragraph is banded above green",
    r.bands.join(","),
  );
  check(r.stretch > 0, "a stretch finding is underlined rather than filled", `${r.stretch}`);
  check(
    r.indices.length > 0 && r.indices.every((i) => /^\d+$/.test(i)),
    "every mark carries a superscript index",
    r.indices.join(","),
  );

  /* ---------- Hovering a note focuses its mark, and the other way ---------- */

  const linked = await evaluate(`(() => {
    const note = document.querySelector(".note");
    note.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    const id = note.dataset.finding;
    const mark = document.querySelector('#report .mark[data-finding="' + id + '"]');
    return JSON.stringify({
      noteActive: note.classList.contains("is-active"),
      markActive: mark ? mark.classList.contains("is-active") : null,
    });
  })()`);
  const link = JSON.parse(linked);
  check(link.noteActive === true, "hovering a note activates it");
  check(link.markActive === true, "hovering a note activates its mark in the document");

  /* ---------- The revision is clean ---------- */

  await evaluate('document.getElementById("load-revision").click()');
  await waitForReport(evaluate);
  const clean = await evaluate(`JSON.stringify({
    marks: document.querySelectorAll("#report .mark").length,
    gate: document.querySelector(".stat-value").textContent,
    clean: document.querySelector(".note-clean") !== null,
    count: document.getElementById("rail-count").textContent,
  })`);
  const c = JSON.parse(clean);
  check(c.marks === 0, "the revision produces no marks", `${c.marks}`);
  check(c.gate === "PASS", "the revision passes the gate", c.gate);
  check(c.clean === true, "the rail says so in words rather than showing an empty list");
  check(c.count.startsWith("0 · "), "the rail header counts zero", c.count);

  /* ---------- Python mode dims the code ---------- */

  await evaluate(
    'document.querySelector(\'#format-control button[data-value="python"]\').click()',
  );
  check(
    (await evaluate("document.body.dataset.format")) === "python",
    "the format control switches the page into Python mode",
  );
  check(
    (await evaluate('document.getElementById("load-sample").textContent')) ===
      "Load AI-flavored retry_client.py",
    "the sample button renames itself in Python mode",
  );
  check(
    (await evaluate('document.getElementById("legend-code").hidden')) === false,
    "the legend gains its code line in Python mode",
  );

  await evaluate('document.getElementById("load-sample").click()');
  await waitForReport(evaluate);
  const python = await evaluate(`JSON.stringify({
    marks: document.querySelectorAll("#report .mark").length,
    dim: document.querySelectorAll("#report .code-dim").length,
    dimText: [...document.querySelectorAll("#report .code-dim")].map(e => e.textContent).join(""),
    font: getComputedStyle(document.getElementById("report")).fontFamily,
  })`);
  const p = JSON.parse(python);
  check(p.marks > 0, "the Python sample is marked inside its docstrings", `${p.marks} mark(s)`);
  check(p.dim > 0, "the code between the docstrings is rendered dimmed", `${p.dim} region(s)`);
  check(
    p.dimText.includes("import random") && p.dimText.includes("def send_with_retry"),
    "the dimmed regions are the code, not the prose",
  );
  check(p.font.includes("IBM Plex Mono"), "the document pane uses the mono face in Python mode", p.font);

  /* ---------- Editing drops the report ---------- */

  await evaluate(`(() => {
    document.getElementById("analyze").click();
    const input = document.getElementById("input");
    input.value = input.value + "\\n# one more line\\n";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  check(
    (await evaluate('document.getElementById("report").hidden')) === true,
    "editing the text puts the page back into edit mode",
  );
  check(
    (await evaluate('document.getElementById("rail-count").textContent')).startsWith("—"),
    "the rail stops claiming a count for text that changed",
  );

  /* ---------- Keyboard ---------- */

  await evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }))`);
  await waitForReport(evaluate);
  check(
    (await evaluate('document.getElementById("report").hidden')) === false,
    "Cmd/Ctrl + Enter analyzes",
  );

  /* ---------- Renders ---------- */

  if (shots) {
    mkdirSync(shots, { recursive: true });
    for (const [name, width, height] of [
      ["desktop", 1560, 1100],
      ["narrow", 390, 900],
    ]) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: width < 700,
      });
      await send("Page.navigate", { url: `${base}index.html` });
      const deadline = Date.now() + 180_000;
      for (;;) {
        const s = await evaluate('document.getElementById("engine").dataset.state');
        if (s === "ready" || s === "failed" || Date.now() > deadline) break;
        await sleep(400);
      }
      await evaluate('document.getElementById("load-sample").click()');
      await waitForReport(evaluate);
      await sleep(900);
      const metrics = await send("Page.getLayoutMetrics");
      const full = Math.min(Math.ceil(metrics.cssContentSize.height), 6000);
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height: full,
        deviceScaleFactor: 1,
        mobile: width < 700,
      });
      await sleep(300);
      const shot = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(shots, `${name}.png`), Buffer.from(shot.data, "base64"));
      console.log(`shot: ${join(shots, `${name}.png`)} (${width}x${full})`);
    }
  }

  const failed = checks.filter((c) => !c.ok).length;
  if (logs.length) console.error(`\n--- console ---\n${logs.join("\n")}`);
  console.log(`\n${checks.length - failed} passed, ${failed} failed`);
  chrome.kill();
  process.exit(failed > 0 ? 1 : 0);
}

/** Waits until a report is on screen, or gives up loudly. */
async function waitForReport(evaluate) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const shown = await evaluate('document.getElementById("report").hidden === false');
    if (shown) {
      // One more frame, so the rail has been written too.
      await sleep(120);
      return;
    }
    if (Date.now() > deadline) throw new Error("no report appeared within 60 s");
    await sleep(200);
  }
}

main().catch((err) => {
  console.error(err);
  chrome.kill();
  process.exit(1);
});
