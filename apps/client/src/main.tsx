import { MediaViewer } from "./MediaViewer";
import { useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import type { BrowserSession, InputAction } from "@browser/protocol";
import "./style.css";
function App() {
  const [token, setToken] = useState(""),
    [url, setUrl] = useState(
      "https://www.selenium.dev/selenium/web/web-form.html",
    ),
    [session, setSession] = useState<BrowserSession>(),
    [frame, setFrame] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const queue = useRef(Promise.resolve()),
    image = useRef<HTMLImageElement>(null),
    lastMove = useRef(0);
  async function request(path: string, method = "GET", body?: unknown) {
    const r = await fetch(`/api${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) {
      const e = await r.json();
      throw new Error(e.error?.message ?? `HTTP ${r.status}`);
    }
    return r;
  }
  async function shot(id: string) {
    const r = await request(`/sessions/${id}/frame`);
    const blob = URL.createObjectURL(await r.blob());
    setFrame((old) => {
      if (old) URL.revokeObjectURL(old);
      return blob;
    });
  }
  function run(fn: () => Promise<void>) {
    queue.current = queue.current.then(async () => {
      setBusy(true);
      setError("");
      try {
        await fn();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    });
    return queue.current;
  }
  async function action(name: string, body: unknown = {}) {
    if (!session) return;
    const s = (await (
      await request(`/sessions/${session.sessionId}/${name}`, "POST", body)
    ).json()) as BrowserSession;
    setSession(s);
    setUrl(s.currentUrl);
    await shot(s.sessionId);
  }
  function coords(e: { clientX: number; clientY: number }) {
    const rect = image.current!.getBoundingClientRect();
    return {
      x: Math.min(
        1279,
        Math.max(0, Math.floor(((e.clientX - rect.left) * 1280) / rect.width)),
      ),
      y: Math.min(
        719,
        Math.max(0, Math.floor(((e.clientY - rect.top) * 720) / rect.height)),
      ),
    };
  }
  function input(a: InputAction) {
    void run(() => action("input", a));
  }
  return (
    <main>
      <h1>Zvonok Browser · Media spike</h1>
      <p>
        Изолированный LiveKit test pattern и отдельный режим Chromium PNG.
      </p>
      <label>
        Dev token{" "}
        <input
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
      </label>
      {location.port === "47832" ? (
        <MediaViewer token={token} />
      ) : (
        <p>
          <a href="http://127.0.0.1:47832">
            Открыть изолированный LiveKit viewer
          </a>
        </p>
      )}
      {location.port === "47832" && (
        <p>
          <a href="http://127.0.0.1:47831">Открыть Chromium PNG diagnostics</a>
        </p>
      )}
      <section hidden={location.port === "47832"}>
        <h2>Slice 1 · PNG diagnostics</h2>
        <div className="toolbar">
          <button
            disabled={busy || (!!session && session.status === "active")}
            onClick={() =>
              void run(async () => {
                const s = await (await request("/sessions", "POST", {})).json();
                setSession(s);
                await shot(s.sessionId);
              })
            }
          >
            Создать браузер
          </button>
          <button
            disabled={busy || !session}
            onClick={() =>
              void run(async () => {
                await request(`/sessions/${session!.sessionId}`, "DELETE");
                setSession(undefined);
                if (frame) URL.revokeObjectURL(frame);
                setFrame("");
              })
            }
          >
            Завершить
          </button>
          {(["back", "forward", "reload"] as const).map((a, i) => (
            <button
              key={a}
              disabled={busy || !session}
              onClick={() => void run(() => action(a))}
            >
              {["Назад", "Вперёд", "Обновить"][i]}
            </button>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => action("navigate", { url }));
          }}
        >
          <label>
            HTTPS адрес{" "}
            <input value={url} onChange={(e) => setUrl(e.target.value)} />
          </label>
          <button disabled={busy || !session}>Перейти</button>
        </form>
        <p role="status">
          {busy
            ? "Выполняется команда…"
            : session
              ? `${session.status} · ${session.sessionId}`
              : "Сессии нет"}
        </p>
        <p role="alert">{error}</p>
        <button
          disabled={busy || !session}
          onClick={() => void run(() => shot(session!.sessionId))}
        >
          Получить кадр
        </button>
        <p>
          Кликните по кадру для фокуса. Печатайте, используйте Tab/Enter и
          прокрутку. Кадр обновляется после команды.
        </p>
        {frame && (
          <img
            ref={image}
            className="viewport"
            src={frame}
            alt="Диагностический кадр серверного браузера, 1280 на 720"
            tabIndex={0}
            onClick={(e) => {
              e.currentTarget.focus();
              input({ type: "mouseClick", ...coords(e), button: "left" });
            }}
            onMouseMove={(e) => {
              if (Date.now() - lastMove.current > 250 && !busy) {
                lastMove.current = Date.now();
                input({ type: "mouseMove", ...coords(e) });
              }
            }}
            onPaste={(e) => {
              e.preventDefault();
              const text = e.clipboardData.getData("text").slice(0, 1000);
              if (text) input({ type: "text", text });
            }}
            onWheel={(e) => {
              e.preventDefault();
              const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 720 : 1;
              input({
                type: "wheel",
                ...coords(e),
                deltaX: Math.max(-2000, Math.min(2000, e.deltaX * unit)),
                deltaY: Math.max(-2000, Math.min(2000, e.deltaY * unit)),
              });
            }}
            onKeyDown={(e) => {
              if (e.ctrlKey && e.key.toLowerCase() === "a") {
                e.preventDefault();
                input({ type: "keyPress", key: "Control+A" });
              } else if (
                [
                  "Enter",
                  "Tab",
                  "Backspace",
                  "Delete",
                  "Escape",
                  "ArrowLeft",
                  "ArrowRight",
                  "ArrowUp",
                  "ArrowDown",
                  "Home",
                  "End",
                  "PageUp",
                  "PageDown",
                ].includes(e.key)
              ) {
                e.preventDefault();
                input({
                  type: "keyPress",
                  key:
                    e.shiftKey && e.key === "Tab"
                      ? "Shift+Tab"
                      : (e.key as Extract<
                          InputAction,
                          {
                            type: "keyPress";
                          }
                        >["key"]),
                });
              } else if (
                e.key.length === 1 &&
                !e.ctrlKey &&
                !e.metaKey &&
                !e.altKey
              ) {
                e.preventDefault();
                input({ type: "text", text: e.key });
              }
            }}
          />
        )}
      </section>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
