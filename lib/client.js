/**
 * dsh-web-share — 浏览器半边
 *
 * 一个插件，两个入口，行为一致（都开新对话）：
 *   ① 侧栏「网页版导出」（sidebar.panellist，order 30）→ main 整页面板
 *   ② 聊天区「网页版」标签页（conversation.view）
 * 两个入口共用同一个列表组件，但**落点不同**：
 *   ① 侧栏面板：没有 session 上下文 → 拿交接包 → 新建对话并预填
 *   ② 对话栏标签页：有 session 上下文 → 拿交接包 → 写进**当前对话**的输入框
 *
 * 安全性：
 *   - 只注册这三个座位，绝不碰 root / sidebar / conversation / details。
 *   - 渲染内容只来自本插件宿主路由，不读会话数据。
 */

window.__ModuleLoader__.load({
  id: "dsh-web-share",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;

    /** 宿主路由：文档相对路径（DSH 用 <base href="./">，绝对 /api 会绕过子路径部署）。 */
    const API_LIST = "api/dsweb/list";
    const API_HANDOFF = "api/dsweb/handoff";
    const API_LOGIN = "api/dsweb/login";
    const API_PREVIEW = "api/dsweb/preview";

    /** 面板 id：sidebar.panellist 的 id 必须与 main 的 key 完全一致。 */
    const PANEL_ID = "web-share";
    /** 聊天区视图 id。 */
    const VIEW_ID = "dsweb";
    /** 侧栏排序：插件 0 / 自动化任务 10 / 任务看板 20 → 我们 30，正好在下面。 */
    const PANEL_ORDER = 30;

    const C = {
      text: "var(--dsw-alias-label-primary, #e8e8ea)",
      dim: "var(--dsw-alias-label-secondary, #a0a0a8)",
      faint: "var(--dsw-alias-label-tertiary, #70707a)",
      border: "var(--dsw-alias-border-l2, rgba(255,255,255,.10))",
      layer: "var(--dsw-alias-bg-layer-2, rgba(255,255,255,.03))",
      brand: "var(--dsw-alias-brand-primary, #4d6bfe)",
    };

    const fmtTime = (epochSec) => {
      if (!epochSec) return "";
      try {
        const d = new Date(epochSec * 1000);
        const p = (n) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
      } catch { return ""; }
    };

    async function getJson(url) {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    }

    /**
     * 挑一个新对话要落在的工作区。
     *
     * 自己算而不是依赖 startSession 的内部兜底：显式传入才能保证成功，
     * 失败时也能给出准确原因（而不是"点了没反应"）。
     * 顺序与官方 recentWorkspace 一致：当前会话所在 → 最近活跃 → 创建时间最新。
     */
    function pickWorkspace(ctx, sessionId) {
      try {
        const workspaces = ctx.get("workspaces");
        const sessions = ctx.get("sessions");
        const snap = workspaces && workspaces.list && workspaces.list.getSnapshot
          ? workspaces.list.getSnapshot()
          : undefined;
        const items = snap && Array.isArray(snap.items) ? snap.items : [];
        if (items.length === 0) return undefined;

        if (sessionId) {
          const own = items.find((it) => Array.isArray(it.sessionIds) && it.sessionIds.includes(sessionId));
          if (own) return own.workspaceId;
        }

        const byId = sessions && sessions.list && sessions.list.getSnapshot
          ? (sessions.list.getSnapshot().byId || {})
          : {};
        let best;
        let bestTime = Number.NEGATIVE_INFINITY;
        for (const it of items) {
          let latest = Number.NEGATIVE_INFINITY;
          for (const sid of (it.sessionIds || [])) {
            const row = byId[sid];
            if (row && typeof row.updatedAt === "number") latest = Math.max(latest, row.updatedAt);
          }
          if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(it.createdAt) || 0;
          if (best === undefined || latest > bestTime) { best = it.workspaceId; bestTime = latest; }
        }
        return best;
      } catch { return undefined; }
    }

    /** 兜底：uiWorkspace 不可用时，退回"写进当前对话的输入框"。 */
    function deliverToCurrentComposer(inputActions, text) {
      if (!inputActions) return false;
      try {
        if (typeof inputActions.captureInsertion === "function" && typeof inputActions.insertText === "function") {
          const span = inputActions.captureInsertion();
          if (inputActions.insertText(text, span) === true) return true;
        }
      } catch { /* 继续 */ }
      try {
        if (typeof inputActions.setDraft === "function") { inputActions.setDraft(text); return true; }
      } catch { /* 继续 */ }
      return false;
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    /**
     * 交接动作：拿包 → 开新对话并预填。
     *
     * 为什么不直接把 prompt 交给 startSession：
     *   实测 `startSession(ws, { prompt })` 会建出新会话，但草稿在 composer 挂载时
     *   被清掉（面板关闭、输入框为空，且无任何报错）。
     *   所以改成三步：先拿到 sessionId → 切过去 → **等挂载完成后重试写草稿**，
     *   用重试赢下这个竞态。
     *
     * @returns kind: opened（开了新对话）| composer（退回写当前输入框）
     */
    async function handoffToNewSession(ctx, sessionId, inputActions, session, pick) {
      const pickParam = Array.isArray(pick) && pick.length > 0 ? `&pick=${pick.join(",")}` : "";
      const r = await getJson(`${API_HANDOFF}?q=${encodeURIComponent(session.id)}&tail=2${pickParam}`);
      if (!r.ok) throw new Error(r.error || "生成交接包失败");

      const get = (n) => (ctx && typeof ctx.get === "function" ? ctx.get(n) : undefined);
      const uiWorkspace = get("uiWorkspace");
      const layout = get("layout");

      // 先离开整页面板，否则会停在面板上看不到新会话
      if (layout && typeof layout.selectPanel === "function") layout.selectPanel(null);

      if (uiWorkspace && (typeof uiWorkspace.connectWorkspace === "function" || typeof uiWorkspace.startSession === "function")) {
        const ws = pickWorkspace(ctx, sessionId);
        if (ws === undefined) {
          throw new Error("没有找到可用的工作区。请先在侧栏「工作区」里新建一个，再回来导出。");
        }

        const sessions = get("sessions");
        const conversation = get("conversation");

        // ① 每次都新建一个会话，**不复用空白会话**。
        //    实测复用会踩到"旧草稿还在 → requestDraftInitialization 返回 preserved
        //    → 新交接包被跳过"，用户看到的就是"点了没反应"。
        let newId;
        if (sessions && typeof sessions.create === "function") {
          newId = await sessions.create({ workspaceId: ws });
        } else if (typeof uiWorkspace.connectWorkspace === "function") {
          newId = await uiWorkspace.connectWorkspace(ws);
        } else {
          uiWorkspace.startSession(ws, { prompt: r.text });
          return { kind: "opened", pack: r, delivered: true };
        }

        // ② 切过去
        if (typeof uiWorkspace.openSession === "function") uiWorkspace.openSession(newId);
        console.info("[dsweb] ws=", ws, " newId=", newId, " target=", session.title);

        // ③ 等 composer 挂载后写草稿；先常规重试，再退化为强制替换
        let delivered = false;
        const trace = [];
        if (conversation?.input?.requestDraftInitialization && sessions?.binding) {
          for (let i = 0; i < 20 && !delivered; i += 1) {
            await sleep(250);
            try {
              const binding = sessions.binding(newId);
              if (!binding) { trace.push(i + ":no-binding"); continue; }
              // 前 10 次按"草稿为空才写"；之后允许强制替换（新会话里不会有用户内容）
              const options = i < 10 ? { prompt: r.text } : { prompt: r.text, clearPreviousDraft: true };
              const res = conversation.input.requestDraftInitialization(binding, options);
              trace.push(i + ":" + res);
              if (res === "applied") delivered = true;
            } catch (e) { trace.push(i + ":err " + String(e && e.message).slice(0, 60)); }
          }
        }
        console.info("[dsweb] delivered=", delivered, " trace=", trace.join(" | "));
        return { kind: "opened", pack: r, delivered, sessionId: newId };
      }

      if (deliverToCurrentComposer(inputActions, r.text)) {
        return { kind: "composer", pack: r };
      }
      throw new Error("找不到可用的会话入口（uiWorkspace 与输入框都不可用）。");
    }

    /**
     * 交接动作（对话栏入口）：把交接包写进**当前对话**的输入框，不开新对话。
     *
     * 与侧栏面板正好相反——那里没有 session 上下文，只能新建；
     * 这里用户就在某个对话里，期望"接着这个对话干"。
     */
    async function handoffIntoCurrent(inputActions, session, pick) {
      const pickParam = Array.isArray(pick) && pick.length > 0 ? `&pick=${pick.join(",")}` : "";
      const r = await getJson(`${API_HANDOFF}?q=${encodeURIComponent(session.id)}&tail=2${pickParam}`);
      if (!r.ok) throw new Error(r.error || "生成交接包失败");
      if (!deliverToCurrentComposer(inputActions, r.text)) {
        throw new Error("当前对话的输入框不可用（可能正在生成回复）。请稍后重试。");
      }
      return { kind: "composer", pack: r, delivered: true };
    }

    /** 侧栏图标：与任务看板同款的内联 SVG（收 props.size）。 */
    function WebBriefIcon(props) {
      const size = props && typeof props.size === "number" ? props.size : 16;
      return h("svg", {
        "data-dsh-panel-entry": PANEL_ID,
        viewBox: "0 0 16 16",
        width: size,
        height: size,
        fill: "none",
        stroke: "currentColor",
        strokeWidth: "1.3",
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
      },
        h("path", { key: "doc", d: "M4 1.75h5L12.25 5v9.25H4z" }),
        h("path", { key: "fold", d: "M9 1.75V5h3.25" }),
        h("path", { key: "shaft", d: "M8 7.6v4.1" }),
        h("path", { key: "head", d: "M6.4 9.2L8 7.6l1.6 1.6" }),
      );
    }

    /**
     * 共用会话列表。两个入口都渲染它，只在外层容器上不同。
     */
    function SessionList(props) {
      const ctx = props.ctx;
      const sessionId = props.sessionId;
      const inputActions = props.inputActions;
      // 侧栏面板没有 session 上下文 → 开新对话；对话栏标签页 → 写进当前对话
      const intoCurrent = props.intoCurrent === true;
      const padded = props.padded === true;

      const [status, setStatus] = React.useState("loading");
      const [sessions, setSessions] = React.useState([]);
      const [error, setError] = React.useState("");
      const [busyId, setBusyId] = React.useState("");
      const [done, setDone] = React.useState(null);
      const [filter, setFilter] = React.useState("");
      const [loginBusy, setLoginBusy] = React.useState(false);
      const [loginMsg, setLoginMsg] = React.useState("");
      // 预览：一次只展开一条；picked 是勾选要完整上传的轮次号
      const [openId, setOpenId] = React.useState("");
      const [pv, setPv] = React.useState(null);
      const [pvBusy, setPvBusy] = React.useState("");
      const [picked, setPicked] = React.useState(new Set());

      const load = React.useCallback(() => {
        let cancelled = false;
        setStatus("loading");
        setError("");
        getJson(API_LIST)
          .then((r) => {
            if (cancelled) return;
            if (!r.ok) { setError(r.error || "读取失败"); setStatus("error"); return; }
            setSessions(r.sessions || []);
            setStatus("ready");
          })
          .catch((e) => {
            if (cancelled) return;
            setError(String(e.message || e));
            setStatus("error");
          });
        return () => { cancelled = true; };
      }, []);

      React.useEffect(() => load(), [load]);

      const run = React.useCallback(async (s, pick) => {
        setBusyId(s.id);
        setError("");
        setDone(null);
        try {
          const out = intoCurrent
            ? await handoffIntoCurrent(inputActions, s, pick)
            : await handoffToNewSession(ctx, sessionId, inputActions, s, pick);
          setDone({
            title: out.pack.title,
            chars: out.pack.chars,
            rounds: out.pack.rounds,
            tailRounds: out.pack.tailRounds,
            kind: out.kind,
            delivered: out.delivered !== false,
            text: out.delivered === false ? out.pack.text : "",
          });
        } catch (e) {
          setError(String(e.message || e));
        } finally {
          setBusyId("");
        }
      }, [ctx, sessionId, inputActions, intoCurrent]);

      /**
       * 首次使用：让宿主打开一个真实浏览器窗口去登录 DeepSeek。
       * 通用驱动（playwright + 系统 Edge/Chrome）第一次必须走这一步；
       * 插件不接触、也不保存任何凭据。
       */
      const doLogin = React.useCallback(async () => {
        setLoginBusy(true);
        setError("");
        setLoginMsg("已打开浏览器窗口，请在里面登录 chat.deepseek.com …（最多等 5 分钟）");
        try {
          const r = await getJson(API_LOGIN);
          if (r.ok) {
            setLoginMsg("登录成功，正在读取会话…");
            load();
          } else {
            setLoginMsg("");
            setError(r.error || r.message || "登录未完成。");
          }
        } catch (e) {
          setLoginMsg("");
          setError(String(e.message || e));
        } finally {
          setLoginBusy(false);
        }
      }, [load]);

      /** 展开/收起预览：一次只开一条，默认勾选最后 2 轮。 */
      const togglePreview = React.useCallback(async (s) => {
        if (openId === s.id) { setOpenId(""); setPv(null); setPicked(new Set()); return; }
        setOpenId(s.id);
        setPv(null);
        setPicked(new Set());
        setPvBusy(s.id);
        setError("");
        try {
          const r = await getJson(`${API_PREVIEW}?q=${encodeURIComponent(s.id)}&tail=4`);
          if (!r.ok) { setError(r.error || "预览失败"); setOpenId(""); return; }
          setPv(r);
          const nums = (r.rounds || []).map((x) => x.n);
          setPicked(new Set(nums.slice(-2)));
        } catch (e) {
          setError(String(e.message || e));
          setOpenId("");
        } finally {
          setPvBusy("");
        }
      }, [openId]);

      const togglePick = React.useCallback((n) => {
        setPicked((prev) => {
          const next = new Set(prev);
          if (next.has(n)) next.delete(n); else next.add(n);
          return next;
        });
      }, []);

      /** 用勾选的轮次导出。 */
      const runPicked = React.useCallback((s) => {
        const nums = [...picked].sort((a, b) => a - b);
        if (nums.length === 0) return;
        run(s, nums);
      }, [picked, run]);

      const shown = filter.trim() === ""
        ? sessions
        : sessions.filter((s) => String(s.title || "").toLowerCase().includes(filter.trim().toLowerCase()));

      const header = h("div", {
        style: {
          display: "flex", alignItems: "center", gap: "10px",
          padding: padded ? "18px 24px" : "14px 20px",
          borderBottom: `1px solid ${C.border}`, flex: "none",
        },
      },
        h("div", { style: { fontWeight: 600, fontSize: padded ? "16px" : "15px", color: C.text } }, "网页版导出"),
        h("div", { style: { fontSize: "12px", color: C.faint } },
          intoCurrent ? "只读 · 导出后填入当前对话输入框" : "只读 · 导出后直接开新对话"),
        h("div", { style: { flex: 1 } }),
        h("button", {
          onClick: doLogin,
          disabled: loginBusy,
          title: "首次使用：打开浏览器窗口登录 chat.deepseek.com（插件不会保存任何凭据）",
          style: {
            padding: "6px 12px", fontSize: "13px", borderRadius: "8px",
            cursor: loginBusy ? "default" : "pointer",
            border: `1px solid ${C.border}`, background: C.layer, color: C.text,
            opacity: loginBusy ? 0.5 : 1,
          },
        }, loginBusy ? "等待登录…" : "登录 DeepSeek"),
        h("input", {
          value: filter,
          onChange: (e) => setFilter(e.target.value),
          placeholder: "筛选标题…",
          style: {
            width: "180px", padding: "6px 10px", fontSize: "13px", borderRadius: "8px",
            border: `1px solid ${C.border}`, background: C.layer, color: C.text, outline: "none",
          },
        }),
        h("button", {
          onClick: load,
          disabled: status === "loading",
          style: {
            padding: "6px 12px", fontSize: "13px", borderRadius: "8px", cursor: "pointer",
            border: `1px solid ${C.border}`, background: C.layer, color: C.text,
            opacity: status === "loading" ? 0.5 : 1,
          },
        }, status === "loading" ? "读取中…" : "刷新"),
      );

      const banner = [];
      if (error !== "") {
        banner.push(h("div", {
          key: "err",
          style: {
            margin: padded ? "14px 24px 0" : "12px 20px 0", padding: "10px 14px", borderRadius: "10px",
            border: "1px solid rgba(255,120,120,.35)", background: "rgba(255,120,120,.10)",
            color: "#ffb4b4", fontSize: "13px", lineHeight: 1.55,
          },
        }, error));
      }
      if (loginMsg !== "") {
        banner.push(h("div", {
          key: "login",
          style: {
            margin: padded ? "14px 24px 0" : "12px 20px 0", padding: "10px 14px", borderRadius: "10px",
            border: `1px solid ${C.border}`, background: C.layer,
            color: C.dim, fontSize: "13px", lineHeight: 1.55,
          },
        }, loginMsg));
      }
      if (done) {
        banner.push(h("div", {
          key: "done",
          style: {
            margin: padded ? "14px 24px 0" : "12px 20px 0", padding: "10px 14px", borderRadius: "10px",
            border: "1px solid rgba(120,220,160,.35)", background: "rgba(120,220,160,.10)",
            color: "#a6e7c3", fontSize: "13px", lineHeight: 1.6,
          },
        },
          h("div", null, done.kind === "composer"
            ? `已填入当前输入框：《${done.title}》· ${done.chars} 字符`
            : done.delivered
              ? `已开新对话：《${done.title}》· ${done.chars} 字符 · 共 ${done.rounds} 轮（最后 ${done.tailRounds} 轮完整）`
              : `已开新对话，但没能自动填入：《${done.title}》· ${done.chars} 字符`),
          h("div", { style: { marginTop: "6px", fontSize: "12px", color: C.dim } },
            done.kind === "composer"
              ? "（新对话入口不可用，已退回写入当前输入框）"
              : done.delivered
                ? "去输入框看一眼、可改，按回车就交给我。前面的轮次已压缩成一行，最后两轮是完整的。"
                : "请手动复制下方文本，粘贴到新对话的输入框。"),
        ));
        if (done && done.text) {
          banner.push(h("textarea", {
            key: "fallback",
            readOnly: true,
            value: done.text,
            onFocus: (e) => e.currentTarget.select(),
            style: {
              margin: padded ? "10px 24px 0" : "8px 20px 0", height: "180px", padding: "10px 12px",
              borderRadius: "10px", border: `1px solid ${C.border}`, background: C.layer,
              color: C.text, fontFamily: "ui-monospace, monospace", fontSize: "12px",
              lineHeight: 1.5, resize: "vertical", outline: "none",
            },
          }));
        }
      }

      const list = h("div", {
        style: { flex: 1, overflowY: "auto", padding: padded ? "10px 16px 32px" : "8px 12px 24px" },
      },
        status === "loading" && sessions.length === 0
          ? h("div", { style: { padding: "32px", textAlign: "center", color: C.dim, fontSize: "13px" } }, "正在读取网页版会话…")
          : shown.length === 0
            ? h("div", { style: { padding: "32px", textAlign: "center", color: C.dim, fontSize: "13px" } },
                sessions.length === 0 ? "没有读到会话。请确认浏览器里已登录 chat.deepseek.com。" : "没有匹配的标题。")
            : shown.map((s) => {
                const open = openId === s.id;
                const row = h("div", {
                  key: s.id + "-row",
                  style: {
                    display: "flex", alignItems: "center", gap: "10px",
                    padding: "10px 12px", borderRadius: open ? "10px 10px 0 0" : "10px",
                    background: open ? C.layer : "transparent",
                  },
                  onMouseEnter: (e) => { if (!open) e.currentTarget.style.background = C.layer; },
                  onMouseLeave: (e) => { if (!open) e.currentTarget.style.background = "transparent"; },
                },
                  h("div", { style: { flex: 1, minWidth: 0 } },
                    h("div", {
                      style: {
                        fontSize: "14px", color: C.text, fontWeight: 500,
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      },
                    }, s.title || "(无标题)"),
                    h("div", { style: { fontSize: "12px", color: C.faint, marginTop: "2px" } },
                      // 消息数来自网页端接口，可能被上游移除；缺了就只显示时间
                      [typeof s.messages === "number" ? `${s.messages} 条消息` : null, fmtTime(s.updatedAt)]
                        .filter(Boolean).join(" · ")),
                  ),
                  h("button", {
                    onClick: () => togglePreview(s),
                    disabled: pvBusy !== "",
                    title: "预览最后几轮，挑要完整上传的轮次",
                    style: {
                      flex: "none", padding: "6px 12px", fontSize: "13px", borderRadius: "8px",
                      cursor: pvBusy === "" ? "pointer" : "default",
                      border: `1px solid ${C.border}`, background: "transparent", color: C.dim,
                      opacity: pvBusy === "" || pvBusy === s.id ? 1 : 0.4,
                    },
                  }, pvBusy === s.id ? "载入…" : open ? "收起" : "预览"),
                  h("button", {
                    onClick: () => run(s),
                    disabled: busyId !== "",
                    title: "按默认（最后 2 轮完整）直接导出",
                    style: {
                      flex: "none", padding: "6px 14px", fontSize: "13px", borderRadius: "8px",
                      cursor: busyId === "" ? "pointer" : "default",
                      border: `1px solid ${C.brand}`, background: "transparent", color: C.brand,
                      opacity: busyId === "" || busyId === s.id ? 1 : 0.4,
                    },
                  }, busyId === s.id ? "生成中…" : (intoCurrent ? "导出到输入框" : "导出到新对话")),
                );

                if (!open) return row;

                // 展开：逐轮列出，可勾选
                const pickedCount = picked.size;
                const body = h("div", {
                  key: s.id + "-body",
                  style: {
                    borderTop: `1px solid ${C.border}`, background: C.layer,
                    borderRadius: "0 0 10px 10px", padding: "10px 12px 12px", marginBottom: "6px",
                  },
                },
                  h("div", { style: { fontSize: "12px", color: C.faint, marginBottom: "8px" } },
                    pv === null
                      ? "正在读取最后几轮…"
                      : `${pv.title} · 共 ${pv.totalRounds} 轮，下面是第 ${pv.from}–${pv.to} 轮。勾选要**完整上传**的轮次（默认已勾最后 2 轮）。`),
                  pv === null ? null : pv.rounds.map((r) => {
                    const checked = picked.has(r.n);
                    return h("label", {
                      key: s.id + "-r" + r.n,
                      style: {
                        display: "block", padding: "8px 10px", marginBottom: "6px", borderRadius: "8px",
                        border: `1px solid ${checked ? C.brand : C.border}`,
                        background: checked ? "rgba(77,107,254,.08)" : "transparent",
                        cursor: "pointer",
                      },
                    },
                      h("div", { style: { display: "flex", alignItems: "center", gap: "8px" } },
                        h("input", {
                          type: "checkbox",
                          checked,
                          onChange: () => togglePick(r.n),
                          style: { margin: 0 },
                        }),
                        h("span", { style: { fontSize: "13px", color: C.text, fontWeight: 600 } }, `第 ${r.n} 轮`),
                        h("span", { style: { fontSize: "12px", color: C.faint } },
                          `我 ${r.userChars} 字 · DeepSeek ${r.assistantChars} 字`),
                      ),
                      h("div", { style: { fontSize: "12px", color: C.dim, marginTop: "4px", lineHeight: 1.55 } },
                        `我：${r.userPeek || "（空）"}`),
                      h("div", { style: { fontSize: "12px", color: C.faint, marginTop: "2px", lineHeight: 1.55 } },
                        `DS：${r.assistantPeek || "（空）"}`),
                    );
                  }),
                  h("div", { style: { display: "flex", alignItems: "center", gap: "8px", marginTop: "8px" } },
                    h("div", { style: { flex: 1, fontSize: "12px", color: C.faint } },
                      pickedCount === 0 ? "还没勾选（至少选 1 轮）" : `已选 ${pickedCount} 轮，其余会压缩成一行`),
                    h("button", {
                      onClick: () => runPicked(s),
                      disabled: busyId !== "" || pickedCount === 0,
                      style: {
                        padding: "6px 14px", fontSize: "13px", borderRadius: "8px",
                        cursor: busyId === "" && pickedCount > 0 ? "pointer" : "default",
                        border: `1px solid ${C.brand}`, background: C.brand, color: "#fff",
                        opacity: busyId === "" && pickedCount > 0 ? 1 : 0.4,
                      },
                    }, busyId === s.id ? "生成中…" : `导出所选 ${pickedCount} 轮`),
                  ),
                );

                return h("div", { key: s.id }, row, body);
              }),
      );

      return h("div", {
        style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 },
        "data-dsh-plugin": "dsweb",
      }, header, ...banner, list);
    }

    /** 侧栏整页面板入口。 */
    function PanelView(props) {
      return h("div", {
        style: { height: "100%", minHeight: 0 },
      }, h(SessionList, { ctx: props.dshCtx, padded: true }));
    }

    /** 聊天区标签页入口。 */
    function TabView(props) {
      return h(SessionList, {
        ctx: props.dshCtx,
        sessionId: props.sessionId ?? props.sid,
        inputActions: props.inputActions,
        intoCurrent: true,
        padded: false,
      });
    }

    function apply(ctx) {
      const slots = ctx.slots;
      if (!slots) return;

      // ① 侧栏一行：只画图标，文字由 label 出
      slots.inject("sidebar.panellist", () => slots.register({
        name: "sidebar.panellist",
        id: PANEL_ID,
        order: PANEL_ORDER,
        label: () => "网页版导出",
      }, WebBriefIcon));

      // ② 整页面板：key 必须与上面的 id 完全一致
      slots.inject("main", () => slots.register({
        name: "main",
        key: PANEL_ID,
        inject: () => ({ dshCtx: ctx }),
      }, PanelView));

      // ③ 聊天区标签页
      slots.inject("conversation.view", () => slots.register({
        name: "conversation.view",
        id: VIEW_ID,
        order: 20,
        label: () => "网页版",
        inject: (sessionId) => ({ dshCtx: ctx, sid: sessionId }),
      }, TabView));
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    exports.name = "dsweb-client";
    return module.exports;
  },
});
