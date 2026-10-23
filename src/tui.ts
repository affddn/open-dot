import { Database } from "bun:sqlite";
import { Plugin } from "@opencode/plugin/tui";
import type { MouseEvent } from "@opentui/core";
import { jsx } from "@opentui/solid/jsx-runtime";
import { createSignal, onCleanup } from "solid-js";
import { databasePath } from "./home";

interface DotEntry {
  readonly name: string;
  readonly sessionID: string;
}

interface WorkerEntry {
  readonly id: number;
  readonly dot: string;
  readonly task: string;
  readonly sessionID: string;
  readonly status: string;
  readonly state: string;
}

const WORKERS_PER_DOT = 10;

/** Reads straight from open-dot's DB. The TUI must not import backend code. */
function read<Row>(sql: string, ...params: number[]): Row[] {
  try {
    const db = new Database(databasePath(), { readonly: true });
    try {
      return db.query<Row, number[]>(sql).all(...params);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

const readDots = () =>
  read<DotEntry>(
    "SELECT name, session_id AS sessionID FROM dots WHERE session_state = 'ready' ORDER BY created_at",
  );

/** Running workers, and those that finished in the last day. */
const readWorkers = () =>
  read<WorkerEntry>(
    `SELECT id, dot, task, session_id AS sessionID, coalesce(outcome, state) AS status, state FROM workers
     WHERE state = 'running' OR (state = 'done' AND finished_at > ?)
     ORDER BY CASE WHEN state = 'running' THEN 0 ELSE 1 END,
       CASE WHEN state = 'running' THEN created_at ELSE finished_at END DESC, id DESC`,
    Date.now() - 24 * 60 * 60 * 1000,
  );

const title = (task: string) => task.trim().split("\n")[0] ?? "";

const short = (task: string) => {
  const line = title(task);
  return line.length > 28 ? `${line.slice(0, 27)}…` : line;
};

const marks: Record<string, string> = { running: "●", succeeded: "✓", failed: "✗" };

interface Line {
  readonly dot: DotEntry;
  readonly worker?: WorkerEntry;
  readonly more?: number;
}

/** Each dot, followed by its workers. */
export function readSidebar(): Line[] {
  const workers = readWorkers();
  return readDots().flatMap((dot) => {
    const recent = workers.filter((worker) => worker.dot === dot.name);
    const running = recent.filter((worker) => worker.state === "running").length;
    const visible = recent.slice(0, Math.max(WORKERS_PER_DOT, running));
    const more = recent.length - visible.length;
    return [
      { dot },
      ...visible.map((worker) => ({ dot, worker })),
      ...(more ? [{ dot, more }] : []),
    ];
  });
}

export const same = (a: Line[], b: Line[]) => JSON.stringify(a) === JSON.stringify(b);

export default Plugin.define({
  id: "open-dot.tui",
  setup(context) {
    const fail = (message: string) =>
      context.ui.toast.show({ title: "open-dot", message, variant: "error" });

    async function open(dot: DotEntry) {
      try {
        await context.client.session.get({ sessionID: dot.sessionID });
        await context.data.session.sync(dot.sessionID);
        context.ui.router.navigate({ type: "session", sessionID: dot.sessionID });
      } catch {
        fail(`Could not open ${dot.name}. Its session ${dot.sessionID} may no longer exist.`);
      }
    }

    async function choose(input?: string) {
      const dots = readDots();
      const name = input?.trim();
      if (name) {
        const dot = dots.find((candidate) => candidate.name === name);
        return dot ? open(dot) : fail(`No dot named "${name}".`);
      }
      const [only] = dots;
      if (!only) return fail("No dots yet. Run: open-dot create <name>");
      if (dots.length === 1) return open(only);
      const picked = await context.ui.dialog.select({
        title: "Open dot",
        options: dots.map((dot) => ({ title: dot.name, value: dot })),
      });
      if (picked) await open(picked);
    }

    const markColor = (status: string) => {
      const { feedback } = context.theme.text;
      if (status === "running") return feedback.warning.base;
      if (status === "succeeded") return feedback.success.base;
      if (status === "failed") return feedback.error.base;
      return context.theme.text.muted;
    };

    const mark = (worker: WorkerEntry) =>
      jsx("span", {
        style: { fg: markColor(worker.status) },
        children: marks[worker.status] ?? "–",
      });

    function showWorker(worker: WorkerEntry) {
      const { theme, renderer } = context;
      const close = () => context.ui.dialog.clear();
      const rest = worker.task.trim().split("\n").slice(1).join("\n").trim();
      // A large dialog leaves about 80 columns for the task.
      const rows = rest
        .split("\n")
        .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 78)), 0);
      context.ui.dialog.show(() => {
        const [screen, setScreen] = createSignal(renderer.terminalHeight);
        const resize = (_width: number, height: number) => setScreen(height);
        renderer.on("resize", resize);
        onCleanup(() => renderer.off("resize", resize));
        return jsx("box", {
          paddingLeft: 2,
          paddingRight: 2,
          paddingBottom: 1,
          gap: 1,
          children: [
            jsx("box", {
              flexDirection: "row",
              justifyContent: "space-between",
              gap: 2,
              children: [
                jsx("text", {
                  fg: theme.text.base,
                  children: jsx("b", { children: `#${worker.id} ${title(worker.task)}` }),
                }),
                jsx("text", { content: "esc", fg: theme.text.muted, onMouseUp: close }),
              ],
            }),
            jsx("text", {
              fg: theme.text.muted,
              children: [mark(worker), ` ${worker.status} · ${worker.dot}`],
            }),
            rest
              ? jsx("scrollbox", {
                  paddingRight: 1,
                  get height() {
                    return Math.min(rows, Math.max(5, Math.floor(screen() / 2) - 6));
                  },
                  children: jsx("text", { content: rest, fg: theme.text.base }),
                })
              : null,
            jsx("box", {
              flexDirection: "row",
              justifyContent: "flex-end",
              children: jsx("box", {
                paddingLeft: 2,
                paddingRight: 2,
                backgroundColor: theme.background.action.primary.base,
                onMouseUp() {
                  close();
                  void open({
                    name: `${worker.dot} worker #${worker.id}`,
                    sessionID: worker.sessionID,
                  });
                },
                children: jsx("text", {
                  content: "Open session",
                  fg: theme.text.action.primary.base,
                }),
              }),
            }),
          ],
        });
      });
      context.ui.dialog.set({ size: "large" });
    }

    async function chooseWorker(dot: DotEntry) {
      const picked = await context.ui.dialog.select({
        title: `${dot.name} workers`,
        options: readWorkers()
          .filter((worker) => worker.dot === dot.name)
          .map((worker) => ({
            title: `#${worker.id} ${title(worker.task)}`,
            description: worker.status,
            value: worker,
          })),
      });
      if (picked) showWorker(picked);
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "open-dot.open",
          title: "Open dot",
          group: "open-dot",
          palette: true,
          slash: { name: "dot", arguments: true },
          run: choose,
        },
      ],
    }));

    // The daemon updates workers from another process, so the sidebar rereads the DB.
    const [rows, setRows] = createSignal(readSidebar(), { equals: same });
    const refresh = setInterval(() => setRows(readSidebar()), 2000);

    const sidebar = context.ui.slot({
      prepend: "sidebar.content",
      render: () =>
        jsx("box", {
          flexDirection: "column",
          children: () =>
            rows().map(({ dot, worker, more }) =>
              worker
                ? jsx("text", {
                    fg: context.theme.text.muted,
                    selectable: false,
                    onMouseUp(event: MouseEvent) {
                      if (event.button === 0) showWorker(worker);
                    },
                    children: ["  ", mark(worker), ` #${worker.id} ${short(worker.task)}`],
                  })
                : more
                  ? jsx("text", {
                      content: `  … ${more} more`,
                      fg: context.theme.text.muted,
                      selectable: false,
                      onMouseUp(event: MouseEvent) {
                        if (event.button === 0) void chooseWorker(dot);
                      },
                    })
                  : jsx("text", {
                      content: `● ${dot.name}`,
                      fg: context.theme.text.base,
                      selectable: false,
                      onMouseUp(event: MouseEvent) {
                        if (event.button === 0) void open(dot);
                      },
                    }),
            ),
        }),
    });

    return () => {
      clearInterval(refresh);
      sidebar();
    };
  },
});
