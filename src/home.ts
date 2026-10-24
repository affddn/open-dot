import { homedir } from "node:os";
import { join } from "node:path";

export const home = () => process.env.OPEN_DOT_HOME ?? join(homedir(), ".opendot");

export const databasePath = () => join(home(), "open-dot.db");

/** Where the daemon writes its local API's URL and token for the notch app. */
export const apiPath = () => join(home(), "api.json");

export const dotDirectory = (name: string) => join(home(), "dots", name);

/** Where a dot's workers run when it names no directory. Outside dots/, so workers get no dot tools. */
export const workDirectory = (name: string) => join(home(), "work", name);

/** The git worktree of a worker that runs in a repository. */
export const worktreeDirectory = (dot: string, id: number) =>
  join(home(), "worktrees", dot, String(id));

/** Where a worker saves files its dot may add to its Library. Only this worker's, never shared. */
export const outputDirectory = (dot: string, id: number) =>
  join(home(), "outputs", dot, String(id));

/** The dot's Library: private, immutable copies of the deliverables it added. */
export const libraryDirectory = (dot: string) => join(home(), "library", dot);
